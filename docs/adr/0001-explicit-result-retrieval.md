# Retrieve delegated results through explicit waits

The first version keeps Codex as the parent host and retrieves Claude Code task results through explicit wait/status calls. T3 can wake a parent because it owns the parent runtime; reproducing that behavior would require a separate, verified host integration beyond the MCP task interface. The user accepts explicit result retrieval, so automatic continuation of an ended parent turn is outside the first version's requirements.
