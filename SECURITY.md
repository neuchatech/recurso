# Security

Recurso is a Pi package. Installing and loading it executes local code with
your user permissions, and Recurso starts additional Pi processes with access
to the tools available in those processes.

Use the same care you would use with any agentic coding environment:

- Review packages before installing them.
- Keep tool allowlists narrow when a thread does not need broad powers.
- Avoid giving spawned threads sensitive credentials unless their task needs
  them.
- Prefer read-only scopes for research and review threads.
- Use `recurso_abort_thread` or `/recurso-stop-all` when a thread is obsolete,
  confused, or taking unsafe action.
- Treat session history as sensitive. Recurso uses Pi's normal session history
  by default so users can inspect work, but those session files may contain
  prompts, code, tool outputs, and model responses.

## Reporting

Open a GitHub issue for security-sensitive behavior that can be discussed
publicly. For private reports, contact the repository owner directly through
the GitHub account that publishes the package.
