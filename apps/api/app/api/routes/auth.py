from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from app.api.deps import AuthServiceDep, CurrentUserDep
from app.domain.models import LoginRequest, RegisterRequest, TokenResponse, UserProfile
from app.services.auth import (
    EmailAlreadyRegisteredError,
    InactiveUserError,
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    UserNotFoundError,
)
from app.settings import settings

router = APIRouter(prefix="/auth", tags=["auth"])

REFRESH_COOKIE_PATH = "/api/auth"


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        key=settings.refresh_cookie_name,
        value=raw_token,
        max_age=settings.refresh_token_ttl_days * 86400,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.refresh_cookie_name,
        path=REFRESH_COOKIE_PATH,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
    )


def _cleared_refresh_error(status_code: int, detail: str) -> JSONResponse:
    # Return an explicit JSONResponse rather than raising HTTPException so FastAPI
    # does not discard the Set-Cookie deletion header on error responses.
    resp = JSONResponse(status_code=status_code, content={"detail": detail})
    _clear_refresh_cookie(resp)
    return resp


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=TokenResponse)
async def register(
    payload: RegisterRequest,
    request: Request,
    response: Response,
    service: AuthServiceDep,
) -> TokenResponse:
    try:
        session = await service.register(
            payload,
            user_agent=request.headers.get("user-agent"),
        )
    except EmailAlreadyRegisteredError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该邮箱已注册",
        ) from exc
    _set_refresh_cookie(response, session.raw_refresh_token)
    return session.token


@router.post("/login", response_model=TokenResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    service: AuthServiceDep,
) -> TokenResponse:
    try:
        session = await service.login(
            payload,
            user_agent=request.headers.get("user-agent"),
        )
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="邮箱或密码错误",
        ) from exc
    except InactiveUserError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已停用",
        ) from exc
    _set_refresh_cookie(response, session.raw_refresh_token)
    return session.token


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    request: Request,
    response: Response,
    service: AuthServiceDep,
) -> TokenResponse | JSONResponse:
    raw_token = request.cookies.get(settings.refresh_cookie_name)
    if not raw_token:
        return _cleared_refresh_error(
            status.HTTP_401_UNAUTHORIZED,
            "会话已失效，请重新登录",
        )
    try:
        session = await service.refresh(
            raw_token,
            user_agent=request.headers.get("user-agent"),
        )
    except InvalidRefreshTokenError:
        return _cleared_refresh_error(
            status.HTTP_401_UNAUTHORIZED,
            "会话已失效，请重新登录",
        )
    except InactiveUserError:
        return _cleared_refresh_error(
            status.HTTP_403_FORBIDDEN,
            "账号已停用",
        )
    _set_refresh_cookie(response, session.raw_refresh_token)
    return session.token


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    service: AuthServiceDep,
) -> None:
    raw_token = request.cookies.get(settings.refresh_cookie_name)
    await service.logout(raw_token)
    _clear_refresh_cookie(response)


@router.get("/me", response_model=UserProfile)
async def me(user: CurrentUserDep, service: AuthServiceDep) -> UserProfile:
    try:
        return await service.get_profile(user.id)
    except UserNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="用户不存在",
        ) from exc
    except InactiveUserError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已停用",
        ) from exc
