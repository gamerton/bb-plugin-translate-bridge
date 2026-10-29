# Contributing

Use Node.js 24, npm and BB 0.48+ with SDK 0.6.94+.

```sh
npm ci --ignore-scripts
npm run check
bb plugin build .
```

Keep changes to translator CLI configuration scoped to translation calls. Do not change global CLI settings, copy login credentials into plugin storage, or silently fall back to full-context coding threads.

The default test suite uses fake CLIs and does not contact model APIs. When changing a CLI adapter, verify the actual outbound request against a local mock endpoint and confirm that its tool list is empty. Document the CLI version used.

Never commit credentials, .env files, databases, conversation exports or node_modules. Include user-facing behavior changes in CHANGELOG.md and keep English and Russian documentation consistent.
