import { useMutation } from '@tanstack/react-query';

import { authClient } from '@/lib/auth-client';

export type DeviceDecision = 'approved' | 'denied';

export interface DeviceAnswer {
  userCode: string;
  decision: DeviceDecision;
}

/**
 * Answer a device's sign-in request. The API binds the pending code to this session first (`GET /device`), then
 * records the decision; the device learns it on its next poll.
 */
export function useAnswerDevice() {
  return useMutation({
    mutationFn: async ({ userCode, decision }: DeviceAnswer) => {
      await authClient.$fetch('/device', { query: { user_code: userCode } });
      if (decision === 'approved') await authClient.device.approve({ userCode });
      else await authClient.device.deny({ userCode });
      return decision;
    }
  });
}
