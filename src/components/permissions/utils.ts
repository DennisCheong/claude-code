import { getHostPlatformForAnalytics } from '../../utils/env.js'
import { isBypassPermissionsModeDisabled } from '../../utils/permissions/permissionSetup.js'
import type { PermissionUpdate } from '../../utils/permissions/PermissionUpdateSchema.js'
import { type CompletionType, logUnaryEvent } from '../../utils/unaryLogging.js'
import type { ToolPermissionContext } from '../../Tool.js'
import type { ToolUseConfirm } from './PermissionRequest.js'

export function logUnaryPermissionEvent(
  completion_type: CompletionType,
  {
    assistantMessage: {
      message: { id: message_id },
    },
  }: ToolUseConfirm,
  event: 'accept' | 'reject',
  hasFeedback?: boolean,
): void {
  void logUnaryEvent({
    completion_type,
    event,
    metadata: {
      language_name: 'none',
      message_id,
      platform: getHostPlatformForAnalytics(),
      hasFeedback: hasFeedback ?? false,
    },
  })
}

export const BYPASS_PERMISSIONS_OPTION_LABEL =
  'Yes, and dangerously skip permissions for this session'

export function createBypassPermissionsModeUpdate(): PermissionUpdate {
  return {
    type: 'setMode',
    mode: 'bypassPermissions',
    destination: 'session',
  }
}

export function shouldOfferBypassPermissionsOption(
  toolPermissionContext: ToolPermissionContext,
): boolean {
  return (
    !isBypassPermissionsModeDisabled() &&
    toolPermissionContext.mode !== 'bypassPermissions'
  )
}

