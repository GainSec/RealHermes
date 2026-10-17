# Security policy

RealHermes handles agent credentials, recorded audio, headset frames and local files, so security reports are welcome.

## Supported versions

RealHermes is a prototype without versioned releases. Security fixes are made on the default branch only; please reproduce issues against its latest commit.

## Reporting a vulnerability

Do not post vulnerability details, exploit code or sensitive data in a public issue.

1. If the repository host offers private vulnerability reporting or private security advisories for this repository, use that.
2. Otherwise, open a public issue titled "Security contact request" that contains no details, and ask GainSec, the repository owner, for a private channel. Share the details only through that channel.

Please include the affected component (relay route, artifact acquisition, local file discovery, launcher, browser client), the configuration needed to reproduce, and its impact. Please also say whether the issue requires a local account, a malicious web page, a malicious artifact source or a malicious Hermes response. There is no bug bounty.

## Scope

In scope: code and configuration in this repository, including the relay, artifact acquisition and caching, approved-folder discovery, the launchers, the doctor and setup scripts, and the browser client.

Out of scope, so please report these to the project concerned:

- vulnerabilities in Hermes Agent itself, its tools or its providers;
- vulnerabilities in third-party dependencies, browsers, headset runtimes, Poppler, ffmpeg or OpenSSH;
- risks documented in [security-privacy.md](docs/security-privacy.md#residual-risks) as known limitations (for example, the relay trusting local callers), unless you find a way around a protection described there;
- setups that expose the relay beyond loopback, which the documentation advises against.

The security model, trust boundaries and residual risks are described in [docs/security-privacy.md](docs/security-privacy.md).
