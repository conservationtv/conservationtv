import { z } from 'zod';

// Form inputs, validated in the browser before anything is sent. Limits mirror the studio API's own validation.

export const EmailSchema = z.object({
  email: z.email('Enter an email address.')
});
export type Email = z.output<typeof EmailSchema>;
export type EmailInput = z.input<typeof EmailSchema>;

export const CodeSchema = z.object({
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter the 6-digit code from your email.')
});
export type Code = z.output<typeof CodeSchema>;
export type CodeInput = z.input<typeof CodeSchema>;

export const AccountNameSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(120, 'Use 120 characters or fewer.')
});
export type AccountName = z.output<typeof AccountNameSchema>;
export type AccountNameInput = z.input<typeof AccountNameSchema>;

export const PasskeyNameSchema = z.object({
  name: z.string().trim().max(64, 'Use 64 characters or fewer.')
});
export type PasskeyName = z.output<typeof PasskeyNameSchema>;
export type PasskeyNameInput = z.input<typeof PasskeyNameSchema>;

export const DeviceCodeSchema = z.object({
  userCode: z
    .string()
    .trim()
    .min(1, 'Enter the code the device shows.')
    .transform(code => code.toUpperCase().replace(/[\s-]/g, ''))
});
export type DeviceCode = z.output<typeof DeviceCodeSchema>;
export type DeviceCodeInput = z.input<typeof DeviceCodeSchema>;
