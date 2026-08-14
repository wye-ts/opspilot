"""FastAPI application factory and entrypoint for the evaluation service."""

from __future__ import annotations

import uuid
from collections.abc import Awaitable, Callable

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response

from opspilot_evaluation.api import router
from opspilot_evaluation.errors import EvaluationApiError, build_error_envelope


def _request_id(request: Request) -> str:
    request_id = getattr(request.state, "request_id", None)
    return request_id if request_id is not None else "unknown"


def create_app() -> FastAPI:
    app = FastAPI(title="opspilot-evaluation", version="0.1.0")
    app.include_router(router)

    @app.middleware("http")
    async def _assign_request_id(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        request.state.request_id = str(uuid.uuid4())
        response = await call_next(request)
        response.headers["X-Request-Id"] = request.state.request_id
        return response

    @app.exception_handler(EvaluationApiError)
    async def _handle_api_error(request: Request, exc: EvaluationApiError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status,
            content=build_error_envelope(exc.code, _request_id(request)),
        )

    @app.exception_handler(RequestValidationError)
    async def _handle_validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # Never echoes exc.errors() (which can carry raw submitted values)
        # back to the caller — only the fixed, safe envelope.
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=build_error_envelope("REQUEST_BODY_INVALID", _request_id(request)),
        )

    @app.exception_handler(Exception)
    async def _handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=build_error_envelope("INTERNAL_ERROR", _request_id(request)),
        )

    return app


app = create_app()
