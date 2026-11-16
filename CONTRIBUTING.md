# Contributing to MirrorCall

Thank you for your interest in contributing to MirrorCall!

## Getting Started

1. Fork the repository on GitHub.
2. Clone your fork locally.
3. Install dependencies:
   ```bash
   npm install
   ```
4. Run tests:
   ```bash
   npm test
   ```

## Development Guidelines

- Ensure all existing unit tests pass (`npm test`).
- MirrorCall is designed for private, two-person communication without accounts. Respect privacy and encryption boundaries.
- Android code lives in `app/`, signaling server in `server/`, Cloudflare worker in `worker/`, and web UI in `web/`.
- Pull requests should be targeted to the `main` branch with clear descriptions of changes.

## License

By contributing, you agree that your contributions will be licensed under the project's [MIT License](LICENSE).
