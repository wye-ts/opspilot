"""Stable, non-leaky error envelope.

Mirrors the shape of apps/api's ApiError/buildErrorEnvelope convention
(apps/api/src/errors/api-error.ts) — a fixed {"error": {"code", "message",
"requestId"}} body, never a raw DB exception, provider payload, or Python
exception string (see the task spec, "Error handling / observability").
"""

from __future__ import annotations

from typing import NamedTuple


class ErrorCatalogEntry(NamedTuple):
    status: int
    message: str


ERROR_CATALOG: dict[str, ErrorCatalogEntry] = {
    "REQUEST_BODY_INVALID": ErrorCatalogEntry(422, "The request body failed validation."),
    "ROUTE_PARAMETER_INVALID": ErrorCatalogEntry(400, "The request path contained an invalid identifier."),
    "EVALUATION_NOT_FOUND": ErrorCatalogEntry(404, "The requested evaluation was not found."),
    # Raised by GET /evaluations/{id} when the persisted run predates the v2
    # cutover (contract_version 1) and therefore cannot be served through the
    # v2-only resource model without an unsafe cast.
    "CONTRACT_VERSION_UNSUPPORTED": ErrorCatalogEntry(
        409, "The stored evaluation uses an unsupported contract version."
    ),
    "PERSISTENCE_FAILED": ErrorCatalogEntry(500, "The evaluation could not be persisted."),
    "INTERNAL_ERROR": ErrorCatalogEntry(500, "An unexpected internal error occurred."),
}


class EvaluationApiError(Exception):
    """Raised anywhere a stable API error response is needed.

    The constructor only accepts a closed error code — never a free-form
    message — so a handler can never accidentally leak internal detail into
    the response body.
    """

    def __init__(self, code: str) -> None:
        if code not in ERROR_CATALOG:
            raise ValueError(f"Unknown error code: {code!r}")
        self.code = code
        self.status, self.message = ERROR_CATALOG[code]
        super().__init__(self.message)


def build_error_envelope(code: str, request_id: str) -> dict[str, object]:
    _, message = ERROR_CATALOG[code]
    return {"error": {"code": code, "message": message, "requestId": request_id}}
