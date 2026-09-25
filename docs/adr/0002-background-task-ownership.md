# Keep delegated work independent of the Codex connection

The user expects Claude Code tasks to continue when Codex closes or its MCP connection disconnects. A separate local background service owns child execution and persists task state and results in SQLite; MCP is the access interface, so its connection lifecycle does not own the work. This adds service lifecycle management in exchange for reconnectable tasks, while recovery after a service crash or machine reboot remains distinct from uninterrupted execution.
