"""External API integrations owned by the UMBRA backend.

Everything in this package talks to a third-party service that needs a
credential. That is the whole point of the package boundary:

    the credential is read here, used here, and never leaves here.

Nothing under ``backend/integrations/`` may return a secret in an HTTP
response, a log line, or an exception message. Endpoints report whether an
integration is *configured* and *connected* — never the key itself.
"""
