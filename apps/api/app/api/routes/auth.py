from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse

from app.api.deps import AuthServiceDep, CurrentUserDep
from app.domain.models import (
    AuthConfigResponse,
    AuthenticatedEmailCodeRequest,
    DeleteAccountRequest,
    EmailCodeSendRequest,
    EmailCodeSendResponse,
    LoginRequest,
    PasswordChangeRequest,
    PasswordResetConfirmRequest,
    RegisterRequest,
    TokenResponse,
    UserProfile,
    UserProfileUpdateRequest,
    VerifyEmailRequest,
)
from app.services.auth import (
    EmailAlreadyRegisteredError,
    EmailCodeCooldownError,
    EmailCodeRateLimitError,
    EmailDeliveryError,
    EmailNotConfiguredError,
    InactiveUserError,
    InvalidCredentialsError,
    InvalidRefreshTokenError,
    InvalidVerificationCodeError,
    SamePasswordError,
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


def _raise_email_send_http_error(
    exc: (
        EmailAlreadyRegisteredError
        | EmailCodeCooldownError
        | EmailCodeRateLimitError
        | EmailNotConfiguredError
        | EmailDeliveryError
    ),
) -> HTTPException:
    if isinstance(exc, EmailAlreadyRegisteredError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="该邮箱已注册",
        )
    if isinstance(exc, EmailCodeCooldownError):
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
            headers={"Retry-After": str(exc.retry_after_seconds)},
        )
    if isinstance(exc, EmailCodeRateLimitError):
        return HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=str(exc),
        )
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail=str(exc),
    )


@router.get("/config", response_model=AuthConfigResponse)
async def config(service: AuthServiceDep) -> AuthConfigResponse:
    return await service.get_config()


@router.post("/email-codes", response_model=EmailCodeSendResponse)
async def send_email_code(
    payload: EmailCodeSendRequest,
    service: AuthServiceDep,
) -> EmailCodeSendResponse:
    try:
        return await service.send_public_email_code(payload)
    except (
        EmailAlreadyRegisteredError,
        EmailCodeCooldownError,
        EmailCodeRateLimitError,
        EmailNotConfiguredError,
        EmailDeliveryError,
    ) as exc:
        raise _raise_email_send_http_error(exc) from exc


@router.post("/me/email-codes", response_model=EmailCodeSendResponse)
async def send_my_email_code(
    payload: AuthenticatedEmailCodeRequest,
    user: CurrentUserDep,
    service: AuthServiceDep,
) -> EmailCodeSendResponse:
    try:
        return await service.send_authenticated_email_code(user.id, payload)
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
    except InvalidVerificationCodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except (
        EmailCodeCooldownError,
        EmailCodeRateLimitError,
        EmailNotConfiguredError,
        EmailDeliveryError,
    ) as exc:
        raise _raise_email_send_http_error(exc) from exc


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
    except InvalidVerificationCodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except EmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
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


@router.patch("/me", response_model=UserProfile)
async def update_me(
    payload: UserProfileUpdateRequest,
    user: CurrentUserDep,
    service: AuthServiceDep,
) -> UserProfile:
    try:
        return await service.update_profile(user.id, payload)
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


@router.post("/verify-email", response_model=UserProfile)
async def verify_email(
    payload: VerifyEmailRequest,
    user: CurrentUserDep,
    service: AuthServiceDep,
) -> UserProfile:
    try:
        return await service.verify_current_user_email(user.id, payload)
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
    except InvalidVerificationCodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except EmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(
    payload: PasswordResetConfirmRequest,
    response: Response,
    service: AuthServiceDep,
) -> None:
    try:
        await service.reset_password(payload)
    except InactiveUserError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="账号已停用",
        ) from exc
    except InvalidVerificationCodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except EmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    _clear_refresh_cookie(response)


@router.post("/password/change", response_model=TokenResponse)
async def change_password(
    payload: PasswordChangeRequest,
    user: CurrentUserDep,
    request: Request,
    response: Response,
    service: AuthServiceDep,
) -> TokenResponse:
    try:
        session = await service.change_password(
            user.id,
            payload,
            user_agent=request.headers.get("user-agent"),
        )
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
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="当前密码错误",
        ) from exc
    except SamePasswordError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    _set_refresh_cookie(response, session.raw_refresh_token)
    return session.token


@router.post("/me/delete", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    payload: DeleteAccountRequest,
    user: CurrentUserDep,
    response: Response,
    service: AuthServiceDep,
) -> None:
    try:
        await service.delete_account(user.id, payload)
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
    except InvalidCredentialsError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="密码错误",
        ) from exc
    except InvalidVerificationCodeError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        ) from exc
    except EmailNotConfiguredError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        ) from exc
    _clear_refresh_cookie(response)
