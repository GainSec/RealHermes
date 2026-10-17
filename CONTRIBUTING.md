# Contributing to RealHermes

Thanks for your interest. RealHermes is a prototype maintained by GainSec. Bug reports, reproducible problem descriptions and documentation fixes are the most helpful contributions.

## Before you start

- **Use issues first.** Open an issue that describes the problem or proposal before writing a large change, so it can be discussed before you invest time.
- **Contribution terms.** RealHermes is offered under a source-available license for personal and non-commercial use, and separately under commercial licenses from GainSec. GainSec can therefore accept only contributions it may distribute under both. Before your first pull request is merged, GainSec may ask you to confirm contribution terms in writing. If you cannot agree to that, please open an issue instead of a pull request.
- **Security problems** go through [SECURITY.md](SECURITY.md), not public issues.

## Making a change

1. Install with `npm ci` and run `npm run doctor`.
2. Write a failing test first, then the change ([development.md](docs/development.md#conventions) describes the conventions and test seams).
3. Keep the security properties intact: credentials and paths stay server-side, inputs are validated and bounded, errors stay sanitized, and launchers manage only the processes they start.
4. Use synthetic fixtures only: reserved names such as `example.com`, documentation IP ranges, `/home/example`-style paths. Never include real hostnames, addresses, user names, keys or captured frames.
5. Update `.env.example` and the documentation when you add a setting or change behavior.
6. Run `npm run verify` and make sure it passes.

## Pull requests

- Keep each pull request focused on one change, and explain what it changes and how you verified it, including manual checks for scene, microphone or headset behavior that tests cannot cover.
- Do not commit `.env`, `dist/`, `node_modules/`, captures, logs or other generated files; `.gitignore` covers them.
- Be respectful and constructive in issues and reviews.
