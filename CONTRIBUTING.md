# Contributing

Thanks for contributing to BoostOS Desktop.

## Development setup

1. Install dependencies:

```bash
bun install
```

2. Copy environment file:

```bash
cp .env.example .env
```

3. Run app:

```bash
bun run dev
```

## Before opening a PR

- run typecheck: `bun run typecheck`
- run lint: `bun run lint`
- keep changes focused and scoped
- include reproduction steps for bug fixes

## Pull request expectations

- explain what changed and why
- include screenshots/gifs for UI changes
- list any follow-up tasks

## Commit style

Conventional-style commits are encouraged:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`

## Security and secrets

- never commit real credentials
- use `.env.example` placeholders only
- report vulnerabilities through `SECURITY.md`
