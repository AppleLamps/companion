# Security Improvements

This document outlines the security enhancements made to The Vibe Companion codebase.

## Critical Security Fixes

### 1. Command Injection Prevention

**Issue**: The CLI launcher used `execSync` with string interpolation to resolve binary paths, allowing command injection through unsanitized input.

**Fix**: 
- Replaced `execSync(\`which ${binary}\`)` with `execFileSync("which", [binary])`
- Added regex validation for binary names: `/^[a-zA-Z0-9_\-\/\.]+$/`
- Applied same fix to git command execution in ws-bridge.ts

**Files Modified**:
- `web/server/cli-launcher.ts:100-107`
- `web/server/ws-bridge.ts:355-363`

**Prevention Pattern**: Always use `execFileSync()` or `spawn()` with array arguments instead of `execSync()` with string templates.

---

### 2. Path Traversal Prevention

**Issue**: The `/api/fs/list` endpoint accepted arbitrary paths without validation, allowing access to any directory on the filesystem (e.g., `/etc/passwd`, `/root/.ssh`).

**Fix**:
- Added `realpath()` resolution to handle symlinks
- Implemented prefix validation to ensure paths are within home directory
- Return 403 Forbidden for paths outside allowed boundaries

**Files Modified**:
- `web/server/routes.ts:60-83`

**Prevention Pattern**: 
```typescript
const realPath = await realpath(basePath);
const allowedBase = homedir();
if (!realPath.startsWith(allowedBase + sep) && realPath !== allowedBase) {
  return error(403, "Access denied");
}
```

---

### 3. Comprehensive Input Validation

**Issue**: Session creation endpoint accepted arbitrary parameters without type checking, length limits, or sanitization.

**Fix**:
- Added type validation for all parameters
- Enforced length limits (e.g., model name < 100 chars)
- Regex validation for specific formats (e.g., binary names)
- Whitelisted allowed environment variables (LANG, LC_ALL, TZ only)
- Validated permission mode against allowed values
- Applied same path validation to `cwd` parameter

**Files Modified**:
- `web/server/routes.ts:13-93`

**Prevention Pattern**: Validate all inputs with:
1. Type checking
2. Length limits
3. Format validation (regex)
4. Whitelisting (for enums and environment variables)

---

### 4. WebSocket Message Schema Validation

**Issue**: JSON messages from CLI and browser were parsed without structure validation, potentially allowing type confusion attacks.

**Fix**:
- Added basic schema validation after JSON.parse()
- Validate presence and type of required fields (e.g., `type`, `content`, `request_id`)
- Validate enum values (e.g., permission behavior must be "allow" or "deny")
- Applied to both CLI and browser message handlers

**Files Modified**:
- `web/server/ws-bridge.ts:191-226, 260-310`

**Prevention Pattern**:
```typescript
const msg = JSON.parse(data);
if (!msg || typeof msg !== "object" || !msg.type || typeof msg.type !== "string") {
  return; // reject
}
// Additional field-specific validation...
```

---

### 5. Session ID Validation

**Issue**: WebSocket routes accepted any UUID-shaped string, potentially creating memory bloat or orphaned sessions.

**Fix**:
- Added UUID format validation for browser connections
- Added session existence check for CLI connections
- Return 404 for unknown sessions, 400 for invalid format

**Files Modified**:
- `web/server/index.ts:47-80`

---

## High Priority Bug Fixes

### 6. Unhandled Promise Rejections

**Issue**: Multiple async operations lacked error handlers, causing potential crashes or silent failures.

**Fixes**:
- Added `.catch()` handlers to stream piping promises
- Added error logging in UI components (HomePage, Sidebar)
- Added proper try-catch blocks with error logging

**Files Modified**:
- `web/server/cli-launcher.ts:317-326`
- `web/src/components/HomePage.tsx:91-109`
- `web/src/components/Sidebar.tsx:23-39`

---

### 7. Race Condition in WebSocket Reconnection

**Issue**: Reconnection logic could attempt to connect to deleted/exited sessions due to timing gap between check and connect.

**Fix**:
- Added double-check for session existence and state before reconnecting
- Check both session state and SDK session status
- Skip reconnection if session is exited

**Files Modified**:
- `web/src/ws.ts:382-401`

---

### 8. Resource Cleanup

**Issues**:
- ReadableStream readers not released on errors
- Debounce timers not cleared on shutdown
- No graceful shutdown handling

**Fixes**:
- Added `finally` blocks to release stream readers
- Added `cleanup()` method to SessionStore for timer cleanup
- Added SIGTERM/SIGINT handlers for graceful shutdown
- Added 30-second timeout for stream reads

**Files Modified**:
- `web/server/cli-launcher.ts:289-326`
- `web/server/session-store.ts:28-34`
- `web/server/index.ts:126-138`

---

## Medium Priority Improvements

### 9. React Error Boundaries

**Issue**: Uncaught React errors caused complete UI crashes with no recovery.

**Fix**:
- Created ErrorBoundary component with user-friendly error display
- Wrapped entire app and individual major components (Sidebar, TopBar, ChatView, TaskPanel)
- Added reload button for easy recovery

**Files Modified**:
- `web/src/components/ErrorBoundary.tsx` (new file)
- `web/src/main.tsx:4-12`
- `web/src/App.tsx:1-92`

---

## Security Best Practices Applied

1. **Defense in Depth**: Multiple layers of validation (input validation, path checking, session validation)
2. **Least Privilege**: Restricted filesystem access to home directory only
3. **Whitelist over Blacklist**: Used whitelists for environment variables and permission modes
4. **Fail Secure**: Denied access on validation failures rather than allowing
5. **Error Handling**: Proper error handling prevents information leakage
6. **Resource Cleanup**: Prevents resource exhaustion attacks
7. **Input Validation**: All user inputs validated before use
8. **Safe APIs**: Used safer API alternatives (execFileSync vs execSync)

---

## Testing Recommendations

### Security Testing

1. **Command Injection Tests**:
   ```bash
   # Should be rejected
   curl -X POST /api/sessions/create -d '{"claudeBinary": "; rm -rf /"}'
   ```

2. **Path Traversal Tests**:
   ```bash
   # Should return 403
   curl '/api/fs/list?path=/etc'
   curl '/api/fs/list?path=../../etc'
   ```

3. **Input Validation Tests**:
   ```bash
   # Should return 400
   curl -X POST /api/sessions/create -d '{"permissionMode": "invalid"}'
   curl -X POST /api/sessions/create -d '{"env": {"PATH": "/usr/bin"}}'
   ```

### Functional Testing

1. Verify sessions can still be created with valid inputs
2. Verify filesystem browsing works within home directory
3. Verify WebSocket connections work correctly
4. Verify error boundaries catch and display errors
5. Verify graceful shutdown cleans up resources

---

## Future Enhancements

1. **Rate Limiting**: Add rate limiting to API endpoints to prevent DoS
2. **CSRF Protection**: Add CSRF tokens for state-changing operations
3. **Content Security Policy**: Implement CSP headers
4. **Session Tokens**: Add authentication tokens for WebSocket connections
5. **Audit Logging**: Log security-relevant events
6. **Schema Validation Library**: Consider using `zod` or `io-ts` for comprehensive schema validation
7. **File Upload Validation**: If file uploads are added, validate MIME types and sizes
8. **Environment Hardening**: Document secure deployment practices
