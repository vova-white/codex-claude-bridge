# Use Node for Runtime and Bun for Package Management

The project will run on Node.js 24.21.0, use Bun 1.4.2 for package management, and use Vite+ 1.0.0-rc.0 tooling. This supersedes the original issue #1 decision to use Bun as the runtime and `bun:sqlite`; any future SQLite binding must support Node, and the binding itself remains undecided. This decision does not change ADR 0001's explicit result retrieval or ADR 0002's independent background service ownership.
