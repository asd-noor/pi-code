# Hooks

httpYac uses a plugin-based hook architecture. Most built-in features are plugins themselves.

## Project-local hooks (`httpyac.config.js`)

Place `httpyac.config.js` (or `.httpyac.js`) at the project root to register hooks without creating a full plugin:

```js
// httpyac.config.js
module.exports = {
  configureHooks: function (api) {
    // Add a header to every request
    api.hooks.onRequest.addHook('addCorrelation', async (request) => {
      request.headers = request.headers || {};
      request.headers['X-App-Version'] = '2.0.0';
    });

    // Strip sensitive data from logged responses
    api.hooks.responseLogging.addHook('removeSensitiveData', function (response) {
      if (response.request) {
        delete response.request.headers['authorization'];
      }
    });

    // Provide custom variables
    api.hooks.provideVariables.addHook('custom', async (envs) => {
      return { customVar: 'hello-from-plugin' };
    });
  }
};
```

## Available hook points

| Hook | When it fires |
|------|---------------|
| `onRequest` | Before each request is sent |
| `responseLogging` | Before response is output (alter display) |
| `provideVariables` | Variable resolution phase |
| `provideEnvironments` | Environment resolution phase |

For the full plugin API, see the [Plugin Development Guide](https://httpyac.github.io/plugins/).

## In-file script event hooks

These are the script-level equivalents — see [references/scripting.md](references/scripting.md) for full details.

| Syntax | Trigger |
|--------|--------|
| `{{ ... }}` | Pre-request |
| `{{@response ... }}` | Post-response |
| `{{@streaming ... }}` | During streaming |
| `{{after ... }}` | After all requests in file |
| `{{+ ... }}` | Before every request (global) |
| `{{+response ... }}` | After every response (global) |
