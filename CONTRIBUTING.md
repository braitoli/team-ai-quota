# Contributing to AI Quota Monitor

Thank you for your interest in contributing to **AI Quota Monitor**! We welcome bug fixes, documentation improvements, new CLI coding agent adapters, and language translations.

---

## Code of Conduct

Please be respectful, constructive, and collaborative in all issues, discussions, and pull requests.

---

## Development Setup

### Prerequisites
- **Node.js**: `v22.0.0` or higher (utilizes native ES modules, `node:test`, and `node:sqlite`).
- **npm**: `v10.0.0` or higher.
- **Python**: `3.9+` (required for running and developing client daemons in `client/`).

### Quick Start

1. **Clone the repository**:
   ```bash
   git clone https://github.com/example-org/ai-quota-monitor.git
   cd ai-quota-monitor
   ```

2. **Configure local environment variables**:
   ```bash
   printf "API_SECRET_KEY=local-test-key\nDEV_SEED=1\n" > .dev.vars
   ```
   *(Note: `.dev.vars` is git-ignored and used by Wrangler local emulation).*

3. **Install dependencies**:
   ```bash
   npm install
   ```

4. **Start local development server**:
   ```bash
   npm run dev
   ```
   The local server starts on `http://127.0.0.1:8799`.

5. **Seed local database with mock test data**:
   ```bash
   npm run seed:local
   ```
   Populates 14 days of realistic multi-account activity into local SQLite Durable Objects.

6. **View local dashboard**:
   Open `http://127.0.0.1:8799/?key=local-test-key` in your web browser.

---

## Running Tests

All changes must pass the full test suite before submission:

```bash
# Run both Node.js unit tests and Python client daemon tests
npm test

# Run only Node.js server and unit tests
node --test test/*.test.js

# Run only Python client daemon unit tests
npm run test:client
```

---

## Architectural & Coding Guidelines

### 1. Zero External Server Dependencies
The core server and worker implementation relies strictly on Web Standards (`fetch`, `Request`, `Response`, `URL`, `TextEncoder`, Web Crypto) and Node.js 22 built-in modules (`node:test`, `node:sqlite`). Do not introduce runtime npm packages without maintainer approval.

### 2. Strict Zero-Fallback Policy
- Errors must surface honestly and visibly (via HTTP error codes, error banners, or structured JSON error responses).
- **Never swallow errors** (`catch` blocks that silently fail or return empty/default mock data are prohibited).
- When an account report or API fails, surface the real status (`AUTH`, `parse_error`, `usage_timeout`) rather than fabricating a 0% reading.

### 3. Mandatory Backward Compatibility
- Maintain compatibility with at least 5 previous client releases.
- Never delete or rename existing REST API fields or query parameters without deprecation cycles and explicit maintainer consensus.
- Both legacy payloads (`{email, used_percent, resets_at}`) and modern multi-window schemas (`five_hour_used`, `seven_day_used`, `thirty_day_used`) must parse cleanly.

### 4. Internationalization (i18n)
All user-facing strings in the dashboard must use the i18n dictionary system in `src/i18n.js`. When adding new UI elements:
- Define the translation key across all 20 supported languages (`en`, `vi`, `zh-CN`, `zh-TW`, `es`, `ja`, `de`, `fr`, `ko`, `pt`, `ru`, `it`, `ar`, `hi`, `id`, `tr`, `pl`, `nl`, `th`, `uk`).
- Add corresponding unit test assertions in `test/i18n.test.js`.

---

## Pull Request Workflow

1. Fork the repository and create your branch from `main`:
   ```bash
   git checkout -b feature/my-new-feature
   ```
2. Commit your changes with clear, descriptive commit messages.
3. Verify all tests pass locally:
   ```bash
   npm test
   ```
4. Push your branch to your fork:
   ```bash
   git push origin feature/my-new-feature
   ```
5. Open a Pull Request against the `main` branch. Provide a concise summary of the problem solved, testing steps verified, and any screenshots for UI adjustments.
