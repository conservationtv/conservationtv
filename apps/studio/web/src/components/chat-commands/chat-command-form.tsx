import type { FC, ReactNode } from 'react';
import { useForm } from '@tanstack/react-form';
import { FieldDescription, FieldGroup } from '@conservationtv/ui/components/field';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';

import { CHAT_AUDIENCES } from '@/components/chat-commands/chat-commands';
import {
  ChatCommandSettingsSchema,
  StandardChatCommandSettingsSchema,
  type ChatCommandSettings,
  type ChatCommandSettingsInput,
  type StandardChatCommandSettings,
  type StandardChatCommandSettingsInput
} from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';

export interface ChatCommandFormProps {
  /** What the form starts from: a new command's defaults, or a stored command's settings. */
  defaultValues: ChatCommandSettingsInput;
  /** Called with the command as the API takes it, once the form is sent and valid. */
  onSubmit: (command: ChatCommandSettings) => void;
  /** What follows the fields: why it was refused, and the button that sends it. */
  children: ReactNode;
}

/**
 * One of the organisation's own chat commands' form, for adding one and for changing one: the word it is used by, who
 * may use it, how long it rests, and what it says. Beneath the fields, how the command is then typed.
 */
export const ChatCommandForm: FC<ChatCommandFormProps> = ({ defaultValues, onSubmit, children }) => {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: ChatCommandSettingsSchema },
    onSubmit: ({ value }) => onSubmit(ChatCommandSettingsSchema.parse(value))
  });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="py-4">
        <form.Field name="name">
          {field => (
            <TextField
              field={field}
              label="Command"
              placeholder="feeding"
              description="The word viewers type after ! in chat. It can’t be one a standard command is used by."
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </form.Field>
        <form.Field name="text">
          {field => <TextField field={field} label="What it says" placeholder="The feeder is filled at 8am." />}
        </form.Field>
        <div className="grid grid-cols-[2fr_1fr] items-start gap-4">
          <form.Field name="audience">
            {field => (
              <SelectField field={field} label="Who may use it">
                {CHAT_AUDIENCES.map(choice => (
                  <NativeSelectOption key={choice.audience} value={choice.audience}>
                    {choice.label}
                  </NativeSelectOption>
                ))}
              </SelectField>
            )}
          </form.Field>
          <form.Field name="cooldownSeconds">
            {field => (
              <TextField
                field={field}
                label="Rest, in seconds"
                description="Before it runs again."
                inputMode="numeric"
                autoComplete="off"
              />
            )}
          </form.Field>
        </div>
        <form.Subscribe selector={state => state.values.name}>
          {name => (
            <FieldDescription>
              Typed in chat as{' '}
              <code className="font-mono text-foreground">
                !{name.trim().replace(/^!/u, '').toLowerCase() || 'command'}
              </code>
            </FieldDescription>
          )}
        </form.Subscribe>
        {children}
      </FieldGroup>
    </form>
  );
};

export interface StandardChatCommandFormProps {
  /** What the form starts from: the standard command's settings as they are now. */
  defaultValues: StandardChatCommandSettingsInput;
  /** Called with the settings as the API takes them, once the form is sent and valid. */
  onSubmit: (settings: StandardChatCommandSettings) => void;
  /** What follows the fields: why it was refused, and the button that sends it. */
  children: ReactNode;
}

/** A standard chat command's form: who may use it, and how long it rests. What it does is the standard's. */
export const StandardChatCommandForm: FC<StandardChatCommandFormProps> = ({ defaultValues, onSubmit, children }) => {
  const form = useForm({
    defaultValues,
    validators: { onSubmit: StandardChatCommandSettingsSchema },
    onSubmit: ({ value }) => onSubmit(StandardChatCommandSettingsSchema.parse(value))
  });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        form.handleSubmit();
      }}
    >
      <FieldGroup className="py-4">
        <div className="grid grid-cols-[2fr_1fr] items-start gap-4">
          <form.Field name="audience">
            {field => (
              <SelectField field={field} label="Who may use it">
                {CHAT_AUDIENCES.map(choice => (
                  <NativeSelectOption key={choice.audience} value={choice.audience}>
                    {choice.label}
                  </NativeSelectOption>
                ))}
              </SelectField>
            )}
          </form.Field>
          <form.Field name="cooldownSeconds">
            {field => (
              <TextField
                field={field}
                label="Rest, in seconds"
                description="Before it runs again."
                inputMode="numeric"
                autoComplete="off"
              />
            )}
          </form.Field>
        </div>
        {children}
      </FieldGroup>
    </form>
  );
};
