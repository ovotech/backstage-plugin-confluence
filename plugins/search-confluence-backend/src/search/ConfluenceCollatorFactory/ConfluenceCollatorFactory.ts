import { Config } from '@backstage/config';
import {
  DocumentCollatorFactory,
  IndexableDocument,
} from '@backstage/plugin-search-common';
import fetch from 'node-fetch';
import pLimit from 'p-limit';
import { Readable } from 'stream';
import { Logger } from 'winston';
import {
  ConfluenceDocument,
  ConfluenceDocumentList,
  IndexableAncestorRef,
  IndexableConfluenceDocument,
  ANNOTATION_OVO_CONFLUENCE_SPACES,
} from './types';
import { CATALOG_FILTER_EXISTS, CatalogApi } from '@backstage/catalog-client';

// Resource type
export const RESOURCE_TYPE_CONFLUENCE_SPACES = 'confluence-spaces';

type ConfluenceCollatorOptions = {
  logger: Logger;

  parallelismLimit: number;

  wikiUrl: string;
  spaces: string[];
  auth: {
    username: string;
    password: string;
  };
  catalogClient?: CatalogApi;
};

export interface UserEntityDocument extends IndexableDocument {
  kind: string;
  login: string;
  email: string;
}

export class ConfluenceCollatorFactory implements DocumentCollatorFactory {
  public readonly type: string = 'confluence';

  private logger: Logger;
  private catalogClient?: CatalogApi;

  private parallelismLimit: number;
  private wikiUrl: string;
  private spaces: string[];
  private auth: { username: string; password: string };

  static fromConfig(
    config: Config,
    options: {
      logger: Logger;
      parallelismLimit?: number;
      catalogClient?: CatalogApi;
    },
  ) {
    return new ConfluenceCollatorFactory({
      logger: options.logger,

      parallelismLimit: options.parallelismLimit || 15,

      wikiUrl: config.getString('confluence.wikiUrl'),
      spaces: config.getStringArray('confluence.spaces'),
      auth: {
        username: config.getString('confluence.auth.username'),
        password: config.getString('confluence.auth.password'),
      },
      catalogClient: options.catalogClient,
    });
  }

  private constructor(options: ConfluenceCollatorOptions) {
    this.logger = options.logger;

    this.parallelismLimit = options.parallelismLimit;
    this.wikiUrl = options.wikiUrl;
    this.spaces = options.spaces;
    this.auth = options.auth;
    if (options.catalogClient) {
      this.catalogClient = options.catalogClient;
    }
  }

  async getCollator() {
    return Readable.from(this.execute());
  }

  private async *execute(): AsyncGenerator<IndexableConfluenceDocument> {
    const spacesList = await this.getSpaces();
    const documentsList = await this.getDocumentsFromSpaces(spacesList);

    const limit = pLimit(this.parallelismLimit);
    const documentsInfo = documentsList.map(document =>
      limit(async () => {
        try {
          return this.getDocumentInfo(document);
        } catch (err) {
          this.logger.warn(`error while indexing document "${document}"`, err);
        }

        return [];
      }),
    );

    const safePromises = documentsInfo.map(promise =>
      promise.catch(error => {
        this.logger.warn(error);

        return [];
      }),
    );

    const documents = (await Promise.all(safePromises)).flat();

    for (const document of documents) {
      yield document;
    }
  }

  private async getSpaces(): Promise<string[]> {
    // If catalogClient is provided then we can try and get Resource entities of type confluence-spaces.
    // and use those instead of fixed list.
    if (this.catalogClient) {
      this.logger.info(
        `Using Resources of type ${RESOURCE_TYPE_CONFLUENCE_SPACES} to index Confluence`,
      );
      const confluenceSpacesKey = `metadata.annotations.${ANNOTATION_OVO_CONFLUENCE_SPACES}`;

      // Create a filter so we only get the Entities we want.
      const filter: Record<string, symbol | string> = {
        kind: 'Resource',
        'spec.type': RESOURCE_TYPE_CONFLUENCE_SPACES,
        [confluenceSpacesKey]: CATALOG_FILTER_EXISTS,
      };

      const confluenceSpaces = await this.catalogClient.getEntities({
        filter: [filter],
      });
      this.logger.debug(
        `Have found ${confluenceSpaces.items.length} Resources of type confluence-spaces`,
      );

      // Parse all the entities and extract the spaces from the annotation.
      // We support multiple resources or a single resource with CSV list.
      const spaces: Array<string> = [];
      confluenceSpaces.items.map(entity => {
        const annotation =
          entity.metadata.annotations![ANNOTATION_OVO_CONFLUENCE_SPACES]!;
        this.logger.debug(
          `metadata.annotations.${ANNOTATION_OVO_CONFLUENCE_SPACES}: ${annotation}`,
        );
        const spaceList: string[] = annotation
          .split(',')
          .map((item: string) => item.trim());
        spaces.push(...spaceList);
      });
      this.logger.info(`Indexing the following spaces ${spaces.toString()}`);
      return spaces;
    }
    return this.spaces;
  }

  private async getDocumentsFromSpaces(spaces: string[]): Promise<string[]> {
    const documentsList = [];

    for (const space of spaces) {
      documentsList.push(...(await this.getDocumentsFromSpace(space)));
    }

    return documentsList;
  }

  private async getDocumentsFromSpace(space: string): Promise<string[]> {
    const documentsList = [];

    this.logger.info(`exploring space ${space}`);

    let next = true;
    let requestUrl = `${this.wikiUrl}/rest/api/content?limit=1000&status=current&spaceKey=${space}`;
    while (next) {
      const data = await this.get<ConfluenceDocumentList>(requestUrl);
      if (!data.results) {
        break;
      }

      documentsList.push(...data.results.map(result => result._links.self));

      if (data._links.next) {
        requestUrl = `${this.wikiUrl}${data._links.next}`;
      } else {
        next = false;
      }
    }

    return documentsList;
  }

  private async getDocumentInfo(
    documentUrl: string,
  ): Promise<IndexableConfluenceDocument[]> {
    this.logger.debug(`fetching document content ${documentUrl}`);

    const data = await this.get<ConfluenceDocument>(
      `${documentUrl}?expand=body.storage,space,ancestors,version`,
    );
    if (!data.status || data.status !== 'current') {
      return [];
    }

    const ancestors: IndexableAncestorRef[] = [
      {
        title: data.space.name,
        location: `${this.wikiUrl}${data.space._links.webui}`,
      },
    ];

    data.ancestors.forEach(ancestor => {
      ancestors.push({
        title: ancestor.title,
        location: `${this.wikiUrl}${ancestor._links.webui}`,
      });
    });

    return [
      {
        title: data.title,
        text: this.stripHtml(data.body.storage.value),
        location: `${this.wikiUrl}${data._links.webui}`,
        spaceKey: data.space.key,
        spaceName: data.space.name,
        ancestors: ancestors,
        lastModifiedBy: data.version.by.publicName,
        lastModified: data.version.when,
        lastModifiedFriendly: data.version.friendlyWhen,
      },
    ];
  }

  private async get<T = any>(requestUrl: string): Promise<T> {
    const base64Auth = Buffer.from(
      `${this.auth.username}:${this.auth.password}`,
      'utf-8',
    ).toString('base64');
    const res = await fetch(requestUrl, {
      method: 'get',
      headers: {
        Authorization: `Basic ${base64Auth}`,
      },
    });

    if (!res.ok) {
      this.logger.warn(
        'non-ok response from confluence',
        requestUrl,
        res.status,
        await res.text(),
      );

      throw new Error(`Request failed with ${res.status} ${res.statusText}`);
    }

    return await res.json();
  }

  private stripHtml(input: string): string {
    return input.replace(/(<([^>]+)>)/gi, '');
  }
}
