import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../../components/ui/Card'
import { Tag } from '../../components/ui/Tag'
import { api } from '../../lib/api'
import { useAuth } from '../../lib/authContext'
import { useAuthConfig } from '../../lib/useAuthConfig'
import { useCooldown } from '../../lib/useCooldown'
import { isSixDigitCode } from '../../lib/validation'
import type { DeleteAccountRequest } from '../../types/api'

export function AccountSecurityPanel({ enabled }: { enabled: boolean }) {
  const { user, updateProfile, verifyEmail, changePassword, deleteAccount } = useAuth()
  const navigate = useNavigate()
  const authConfigQuery = useAuthConfig(enabled && Boolean(user))
  const authConfig = authConfigQuery.data ?? null

  const verifyCooldown = useCooldown()
  const deleteCooldown = useCooldown()

  const [verifyCode, setVerifyCode] = useState('')
  const [sendingVerifyCode, setSendingVerifyCode] = useState(false)
  const [verifyingEmail, setVerifyingEmail] = useState(false)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [verifyNotice, setVerifyNotice] = useState<string | null>(null)

  const [draftDisplayName, setDraftDisplayName] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [profileError, setProfileError] = useState<string | null>(null)
  const [profileNotice, setProfileNotice] = useState<string | null>(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [changingPassword, setChangingPassword] = useState(false)
  const [passwordError, setPasswordError] = useState<string | null>(null)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)

  const [dangerOpen, setDangerOpen] = useState(true)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteCode, setDeleteCode] = useState('')
  const [deleteConfirmed, setDeleteConfirmed] = useState(false)
  const [sendingDeleteCode, setSendingDeleteCode] = useState(false)
  const [deletingAccount, setDeletingAccount] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deleteCodeNotice, setDeleteCodeNotice] = useState<string | null>(null)

  if (!enabled || !user) {
    return null
  }

  const displayNameValue = draftDisplayName ?? user.display_name
  const hasEmail = Boolean(user.email)
  const isDeleteConfigLoading =
    hasEmail && (authConfigQuery.isPending || (authConfigQuery.isFetching && !authConfig))
  const isDeleteConfigError =
    hasEmail && !isDeleteConfigLoading && authConfigQuery.isError && !authConfig
  const deleteBlockedByConfig = hasEmail && !authConfig
  const requiresDeleteCode = Boolean(authConfig?.email_verification_required) && hasEmail
  const showDeleteCodeField =
    authConfig !== null &&
    (authConfig.email_verification_required || authConfig.smtp_configured) &&
    hasEmail

  async function handleSendVerifyCode() {
    if (sendingVerifyCode || verifyCooldown.secondsLeft > 0 || verifyingEmail) {
      return
    }
    setVerifyError(null)
    setVerifyNotice(null)
    setSendingVerifyCode(true)
    try {
      const res = await api.sendMyEmailCode({ purpose: 'verify_email' })
      verifyCooldown.start(res.cooldown_seconds || authConfig?.code_cooldown_seconds || 60)
      setVerifyNotice(res.message || '验证邮件已发送至您的邮箱，请注意查收')
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : '验证邮件发送失败，请稍后重试')
    } finally {
      setSendingVerifyCode(false)
    }
  }

  async function handleVerifyEmail() {
    if (verifyingEmail) {
      return
    }
    const trimmedCode = verifyCode.trim()
    if (!isSixDigitCode(trimmedCode)) {
      setVerifyError('请输入 6 位数字邮箱验证码')
      return
    }
    setVerifyError(null)
    setVerifyNotice(null)
    setVerifyingEmail(true)
    try {
      await verifyEmail({ verification_code: trimmedCode })
      verifyCooldown.reset()
      setVerifyCode('')
      setVerifyNotice('邮箱验证成功')
    } catch (err) {
      setVerifyError(err instanceof Error ? err.message : '邮箱验证失败，请检查验证码')
    } finally {
      setVerifyingEmail(false)
    }
  }

  async function handleUpdateProfile() {
    if (savingProfile) {
      return
    }
    const trimmedName = displayNameValue.trim()
    if (!trimmedName || trimmedName.length > 64) {
      setProfileError('请输入 1–64 个字符的显示昵称')
      return
    }
    setProfileError(null)
    setProfileNotice(null)
    setSavingProfile(true)
    try {
      await updateProfile({ display_name: trimmedName })
      setDraftDisplayName(null)
      setProfileNotice('显示昵称已更新')
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : '昵称保存失败，请稍后重试')
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleChangePassword() {
    if (changingPassword) {
      return
    }
    if (!currentPassword) {
      setPasswordError('请输入当前密码')
      return
    }
    if (currentPassword.length > 128) {
      setPasswordError('当前密码长度不能超过 128 位')
      return
    }
    if (newPassword.length < 8) {
      setPasswordError('新密码至少需要 8 位')
      return
    }
    if (newPassword.length > 128) {
      setPasswordError('新密码长度不能超过 128 位')
      return
    }
    if (newPassword === currentPassword) {
      setPasswordError('新密码不能与当前密码相同')
      return
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致')
      return
    }
    setPasswordError(null)
    setPasswordNotice(null)
    setChangingPassword(true)
    try {
      await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      })
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPasswordNotice('密码修改成功，当前会话已保持在线')
    } catch (err) {
      setPasswordError(err instanceof Error ? err.message : '密码修改失败，请稍后重试')
    } finally {
      setChangingPassword(false)
    }
  }

  async function handleSendDeleteCode() {
    if (sendingDeleteCode || deleteCooldown.secondsLeft > 0 || deletingAccount) {
      return
    }
    setDeleteError(null)
    setDeleteCodeNotice(null)
    setSendingDeleteCode(true)
    try {
      const res = await api.sendMyEmailCode({ purpose: 'delete_account' })
      deleteCooldown.start(res.cooldown_seconds || authConfig?.code_cooldown_seconds || 60)
      setDeleteCodeNotice(res.message || '注销验证码已发送至您的邮箱，请注意查收')
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '注销验证码发送失败，请稍后重试')
    } finally {
      setSendingDeleteCode(false)
    }
  }

  async function handleDeleteAccount() {
    if (deletingAccount || deleteBlockedByConfig) {
      return
    }
    if (!deletePassword) {
      setDeleteError('请输入当前登录密码')
      return
    }
    if (deletePassword.length > 128) {
      setDeleteError('密码长度不能超过 128 位')
      return
    }
    const trimmedCode = deleteCode.trim()
    if (requiresDeleteCode) {
      if (!isSixDigitCode(trimmedCode)) {
        setDeleteError('请输入 6 位数字注销验证码')
        return
      }
    } else if (trimmedCode.length > 0 && !isSixDigitCode(trimmedCode)) {
      setDeleteError('注销验证码须为 6 位数字')
      return
    }
    if (!deleteConfirmed) {
      setDeleteError('请先勾选确认永久删除账户及全部关联数据')
      return
    }
    setDeleteError(null)
    setDeletingAccount(true)
    try {
      const payload: DeleteAccountRequest = {
        password: deletePassword,
        ...(trimmedCode ? { verification_code: trimmedCode } : {}),
      }
      await deleteAccount(payload)
      void navigate('/', { replace: true })
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '账户注销失败，请稍后重试')
    } finally {
      setDeletingAccount(false)
    }
  }

  return (
    <Card
      title="账号安全与个人设置"
      extra={
        <Tag color={user.email_verified ? 'green' : 'amber'}>
          {user.email_verified ? '已完成邮箱认证' : '待完成邮箱认证'}
        </Tag>
      }
    >
      <div className="stack" style={{ gap: 16 }}>
        <section className="subpanel stack" aria-label="邮箱认证状态">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <div className="sentinel-list">
              <strong className="small">邮箱认证状态</strong>
              <Tag color={user.email_verified ? 'green' : 'amber'}>
                {user.email_verified ? '认证通过' : '尚未认证'}
              </Tag>
            </div>
            <span className="small muted mono wrap-anywhere">{user.email ?? '未绑定邮箱'}</span>
          </div>

          {verifyNotice ? (
            <div className="notice-box notice-success" role="status">
              {verifyNotice}
            </div>
          ) : null}

          {user.email_verified ? (
            <p className="small soft">您的邮箱已完成验证，可用于密码重置与敏感安全操作校验。</p>
          ) : !user.email ? (
            <p className="small muted">当前账户未绑定邮箱地址，暂不支持邮箱验证码认证。</p>
          ) : (
            <form
              className="stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void handleVerifyEmail()
              }}
            >
              <div className="field">
                <label htmlFor="security-verify-email-code">邮箱验证码</label>
                <div className="input-action-row">
                  <input
                    id="security-verify-email-code"
                    className="input mono"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    disabled={verifyingEmail}
                    placeholder="输入 6 位数字验证码"
                    value={verifyCode}
                    onChange={(event) => {
                      setVerifyCode(event.target.value)
                      setVerifyError(null)
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={sendingVerifyCode || verifyCooldown.secondsLeft > 0 || verifyingEmail}
                    onClick={() => {
                      void handleSendVerifyCode()
                    }}
                  >
                    {sendingVerifyCode
                      ? '发送中...'
                      : verifyCooldown.secondsLeft > 0
                        ? `重新发送 (${verifyCooldown.secondsLeft}s)`
                        : '发送验证邮件'}
                  </button>
                  <button type="submit" className="btn-primary" disabled={verifyingEmail}>
                    {verifyingEmail ? '验证中...' : '验证邮箱'}
                  </button>
                </div>
              </div>

              {verifyError ? (
                <div className="inline-error" role="alert">
                  {verifyError}
                </div>
              ) : null}
            </form>
          )}
        </section>

        <div className="security-grid">
          <form
            className="subpanel stack"
            noValidate
            aria-label="昵称设置"
            onSubmit={(event) => {
              event.preventDefault()
              void handleUpdateProfile()
            }}
          >
            <strong className="small">昵称设置</strong>

            <div className="field">
              <label htmlFor="security-display-name">显示昵称</label>
              <input
                id="security-display-name"
                className="input"
                type="text"
                maxLength={64}
                disabled={savingProfile}
                placeholder="1–64 个字符"
                value={displayNameValue}
                onChange={(event) => {
                  setDraftDisplayName(event.target.value)
                  setProfileError(null)
                  setProfileNotice(null)
                }}
              />
            </div>

            {profileError ? (
              <div className="inline-error" role="alert">
                {profileError}
              </div>
            ) : null}

            {profileNotice ? (
              <div className="notice-box notice-success" role="status">
                {profileNotice}
              </div>
            ) : null}

            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={savingProfile}>
                {savingProfile ? '保存中...' : '保存昵称'}
              </button>
            </div>
          </form>

          <form
            className="subpanel stack"
            noValidate
            aria-label="修改密码"
            onSubmit={(event) => {
              event.preventDefault()
              void handleChangePassword()
            }}
          >
            <strong className="small">修改密码</strong>

            <div className="field">
              <label htmlFor="security-current-password">当前密码</label>
              <input
                id="security-current-password"
                className="input"
                type="password"
                autoComplete="current-password"
                maxLength={128}
                disabled={changingPassword}
                placeholder="请输入当前密码"
                value={currentPassword}
                onChange={(event) => {
                  setCurrentPassword(event.target.value)
                  setPasswordError(null)
                  setPasswordNotice(null)
                }}
              />
            </div>

            <div className="field">
              <label htmlFor="security-new-password">新密码</label>
              <input
                id="security-new-password"
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                disabled={changingPassword}
                placeholder="至少 8 位字符"
                value={newPassword}
                onChange={(event) => {
                  setNewPassword(event.target.value)
                  setPasswordError(null)
                  setPasswordNotice(null)
                }}
              />
            </div>

            <div className="field">
              <label htmlFor="security-confirm-password">确认新密码</label>
              <input
                id="security-confirm-password"
                className="input"
                type="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={128}
                disabled={changingPassword}
                placeholder="再次输入新密码"
                value={confirmPassword}
                onChange={(event) => {
                  setConfirmPassword(event.target.value)
                  setPasswordError(null)
                  setPasswordNotice(null)
                }}
              />
            </div>

            {passwordError ? (
              <div className="inline-error" role="alert">
                {passwordError}
              </div>
            ) : null}

            {passwordNotice ? (
              <div className="notice-box notice-success" role="status">
                {passwordNotice}
              </div>
            ) : null}

            <div className="form-actions">
              <button type="submit" className="btn-primary" disabled={changingPassword}>
                {changingPassword ? '修改中...' : '修改密码'}
              </button>
            </div>
          </form>
        </div>

        <section className="danger-zone" aria-label="永久注销账户">
          <div className="row" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="prefs-toggle-btn danger-zone-title"
              aria-expanded={dangerOpen}
              onClick={() => setDangerOpen((open) => !open)}
            >
              <span>永久注销账户（危险操作）</span>
              <span className="small muted">{dangerOpen ? '收起' : '展开'}</span>
            </button>
            <Tag color="rose">不可恢复</Tag>
          </div>

          <p className="small soft">
            注销后将永久清除自选愿望单、投资日记时间胶囊、哨兵与 BYOK 配置，所有会话将立即失效。
          </p>

          {isDeleteConfigLoading ? (
            <div className="notice-box" role="status">
              正在加载邮箱安全配置...
            </div>
          ) : null}

          {isDeleteConfigError ? (
            <div className="inline-error row" style={{ flexWrap: 'wrap' }} role="alert">
              <span className="small">邮箱安全配置加载失败，暂无法确认注销验证要求</span>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  void authConfigQuery.refetch()
                }}
              >
                重试加载配置
              </button>
            </div>
          ) : null}

          {dangerOpen ? (
            <form
              className="stack"
              noValidate
              onSubmit={(event) => {
                event.preventDefault()
                void handleDeleteAccount()
              }}
            >
              <div className="field">
                <label htmlFor="security-delete-password">注销确认密码</label>
                <input
                  id="security-delete-password"
                  className="input"
                  type="password"
                  autoComplete="current-password"
                  maxLength={128}
                  disabled={deletingAccount}
                  placeholder="请输入当前登录密码"
                  value={deletePassword}
                  onChange={(event) => {
                    setDeletePassword(event.target.value)
                    setDeleteError(null)
                  }}
                />
              </div>

              {showDeleteCodeField ? (
                <div className="field">
                  <label htmlFor="security-delete-code">注销验证码</label>
                  <div className="input-action-row">
                    <input
                      id="security-delete-code"
                      className="input mono"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      disabled={deletingAccount}
                      placeholder={
                        requiresDeleteCode ? '输入 6 位数字验证码' : '6 位数字验证码（可选）'
                      }
                      value={deleteCode}
                      onChange={(event) => {
                        setDeleteCode(event.target.value)
                        setDeleteError(null)
                      }}
                    />
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={
                        sendingDeleteCode || deleteCooldown.secondsLeft > 0 || deletingAccount
                      }
                      onClick={() => {
                        void handleSendDeleteCode()
                      }}
                    >
                      {sendingDeleteCode
                        ? '发送中...'
                        : deleteCooldown.secondsLeft > 0
                          ? `重新发送 (${deleteCooldown.secondsLeft}s)`
                          : '发送注销验证码'}
                    </button>
                  </div>
                  {deleteCodeNotice ? (
                    <div className="notice-box" role="status">
                      {deleteCodeNotice}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <label className="checkbox-row" htmlFor="security-delete-confirm">
                <input
                  id="security-delete-confirm"
                  type="checkbox"
                  checked={deleteConfirmed}
                  disabled={deletingAccount}
                  onChange={(event) => {
                    setDeleteConfirmed(event.target.checked)
                    setDeleteError(null)
                  }}
                />
                <span>我确认永久删除账户及全部关联数据</span>
              </label>

              {deleteError ? (
                <div className="inline-error" role="alert">
                  {deleteError}
                </div>
              ) : null}

              <div className="form-actions">
                <button
                  type="submit"
                  className="btn-danger"
                  disabled={!deleteConfirmed || deletingAccount || deleteBlockedByConfig}
                >
                  {deletingAccount ? '注销中...' : '永久注销账户'}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      </div>
    </Card>
  )
}
