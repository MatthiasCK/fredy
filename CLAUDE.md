# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Fredy is a self-hosted real estate finder for Germany that automatically scrapes multiple property listing platforms and notifies users via multiple channels when new listings appear.

## Common Commands

```bash
# Install dependencies
yarn

# Development (run both in separate terminals)
yarn start:backend:dev    # Backend with hot reload (nodemon)
yarn start:frontend:dev   # Frontend dev server (Vite, proxies /api to port 9998)

# Production
yarn start:backend        # Start backend on port 9998
yarn start:frontend       # Serve built frontend

# Build frontend
yarn build:frontend       # Outputs to ui/public

# Testing
yarn test                 # Run all tests (Mocha + Chai with ESM mocking)
yarn testGH               # GitHub Actions suite (excludes provider tests)

# Code quality
yarn lint                 # Run ESLint
yarn lint:fix             # Fix linting issues
yarn format               # Format with Prettier
yarn format:check         # Check formatting

# Database
yarn migratedb            # Run database migrations
yarn migratedb:overwrite  # Force migration with checksum update
```

## Architecture

### Core Pattern: Provider → Adapter → Job

- **Providers** (`lib/provider/`): Scrapers for real estate platforms (ImmoScout24, Immowelt, Kleinanzeigen, WG-Gesucht, etc.)
- **Adapters** (`lib/notification/adapter/`): Notification channels (Slack, Telegram, Email, Discord, etc.)
- **Jobs**: User-configured combinations of providers + adapters that run at intervals

### Pipeline Flow (FredyPipelineExecutioner.js)

1. Prepare provider URL with sorting/parameters
2. Extract raw listings from provider HTML/API
3. Normalize listings to common schema
4. Filter incomplete/blacklisted entries
5. Identify new listings vs stored hashes
6. Persist new listings to SQLite
7. Filter similar entries (cross-platform dedup)
8. Dispatch notifications via configured adapters

### Key Directories

- `lib/api/routes/` - REST API endpoints (restana framework)
- `lib/services/storage/` - SQLite persistence layer with migrations
- `lib/services/jobs/jobExecutionService.js` - Cron scheduler and job executor
- `lib/services/similarity-check/` - Duplicate detection across providers
- `ui/src/views/` - React page components
- `ui/src/components/` - Reusable UI components (Semi Design)

### Entry Point

`index.js` initializes: SQLite → migrations → providers → similarity cache → API server → crons → job scheduler

## Tech Stack

- **Backend**: Node.js 22+, restana, better-sqlite3, cheerio, puppeteer
- **Frontend**: React 18, Vite, Semi Design (@douyinfe/semi-ui), MapLibre GL, zustand
- **Testing**: Mocha, Chai, esmock

## Adding Providers/Adapters

See `CONTRIBUTING.md` for templates and patterns. Each adapter has a `.md` file in `lib/notification/adapter/` for UI documentation.

## Special Notes

- ImmoScout24 uses a reverse-engineered mobile API (see `reverse-engineered-immoscout.md`)
- Pre-commit hooks run ESLint, Prettier, and copyright header checks
- All files require Apache-2.0 license header (`yarn copyright` to add)

## Important to consider
- Implement changes in a manner to require as little changes as possible in existing files. This is to enable efficient merges from the remote repository
- When you have a feature completly developed, ask for a check and require approval. Once the user has approved the code make a commit for the Repository.


