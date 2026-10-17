import type { Variables } from '../env/config.ts';

export interface OtpMessage {
  email: string;
  otp: string;
  type: string;
}
export type OtpDelivery = (message: OtpMessage) => Promise<void>;

/**
 * How sign-in and verification codes reach people. Only logging exists, for local development: the config schema
 * accepts no other value, so a deployment fails closed until an email provider is wired in here.
 */
export function otpDelivery(mode: Variables['OTP_DELIVERY']): OtpDelivery {
  switch (mode) {
    case 'log':
      return async ({ email, otp, type }) => {
        console.info(JSON.stringify({ event: 'email_otp', email, type, otp }));
      };
  }
}
