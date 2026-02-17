# Connector Install

## Remote one-liner (macOS/Linux)
```bash
curl -fsSL <APP_ORIGIN>/install-connector.sh | bash
```

If jobs stay queued, inspect runner logs on target machine:
```bash
tail -f ~/.agenthub-connector/connector.log
```

## Local repo one-liner (all platforms)
```bash
npm install && npm run connector:install -- <PAIRING_CODE>
```
