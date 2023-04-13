# Confluence search plugin backend [![](https://img.shields.io/npm/v/@k-phoen/backstage-plugin-confluence-backend.svg)](https://www.npmjs.com/package/@k-phoen/backstage-plugin-confluence-backend)

This plugin integrates Confluence documents to Backstage' search engine.

It is used in combination with its [frontend counter-part](../search-confluence/).

## Installation

Add the plugin to your backend app:

```bash
cd packages/backend && yarn add @k-phoen/backstage-plugin-confluence-backend
```

Configure the plugin in `app-config.yaml`:

```yaml
# app-config.yaml
confluence:
  # Confluence base URL for wiki API
  # Typically: https://{org-name}.atlassian.net/wiki
  wikiUrl: https://org-name.atlassian.net/wiki

  # List of spaces to index
  # See https://confluence.atlassian.com/conf59/spaces-792498593.html
  spaces: [ENG]

  # Authentication credentials towards Confluence API
  auth:
    username: ${CONFLUENCE_USERNAME}
    # While Confluence supports BASIC authentication, using an API token is preferred.
    # See: https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/
    password: ${CONFLUENCE_PASSWORD}
```

It is also possible to use a `Resource` in the catalog to specify the `spaces` to index.
The `Resource` should like like this:

```yaml
apiVersion: backstage.io/v1alpha1
kind: Resource
metadata:
  name: company-confluence-spaces
  description: List of all company Confluence spaces to index
  annotations:
    atlassian.net/confluence-spaces: 'Eng, Sales, Marketing, BizDev'
spec:
  type: confluence-spaces
  owner: my-team
```

Enable Confluence documents indexing in the search engine:

```typescript
// packages/backend/src/plugins/search.ts
import { ConfluenceCollatorFactory } from '@k-phoen/backstage-plugin-confluence-backend';

export default async function createPlugin({
  logger,
  permissions,
  discovery,
  config,
  tokenManager,
}: PluginEnvironment) {
  // Initialize a connection to a search engine.
  const searchEngine = await ElasticSearchSearchEngine.fromConfig({
    logger,
    config,
  });
  const indexBuilder = new IndexBuilder({ logger, searchEngine });

  // …

  // Confluence indexing
  const halfHourSchedule = env.scheduler.createScheduledTaskRunner({
    frequency: Duration.fromObject({ minutes: 30 }),
    timeout: Duration.fromObject({ minutes: 15 }),
    // A 3 second delay gives the backend server a chance to initialize before
    // any collators are executed, which may attempt requests against the API.
    initialDelay: Duration.fromObject({ seconds: 3 }),
  });
  indexBuilder.addCollator({
    schedule: halfHourSchedule,
    factory: ConfluenceCollatorFactory.fromConfig(env.config, {
      logger: env.logger,
    }),
  });

  // …

  // The scheduler controls when documents are gathered from collators and sent
  // to the search engine for indexing.
  const { scheduler } = await indexBuilder.build();

  // A 3 second delay gives the backend server a chance to initialize before
  // any collators are executed, which may attempt requests against the API.
  setTimeout(() => scheduler.start(), 3000);
  useHotCleanup(module, () => scheduler.stop());

  return await createRouter({
    engine: indexBuilder.getSearchEngine(),
    types: indexBuilder.getDocumentTypes(),
    permissions,
    config,
    logger,
  });
}
```

If you have decided to use the Catalog (`Resource`) to define the spaces to index then there is a small change to the
initialisation code:

```typescript
...
indexBuilder.addCollator({
  schedule: halfHourSchedule,
  factory: ConfluenceCollatorFactory.fromConfig(env.config, {
    logger: env.logger,
    catalogClient: new CatalogClient({ discoveryApi: env.discovery }),
  }),
});
...
```

This will ensure the Catalog Client is specified - and it can then get the `Resources` of the specified type.

## License

This library is under the [MIT](../../LICENSE) license.
