import type { FC, ReactNode } from 'react';
import { useForm, type AnyFieldApi } from '@tanstack/react-form';
import { useSuspenseQuery } from '@tanstack/react-query';
import type { Camera } from '@conservationtv/studio-sdk';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle
} from '@conservationtv/ui/components/field';
import { NativeSelectOption } from '@conservationtv/ui/components/native-select';
import { RadioGroup, RadioGroupItem } from '@conservationtv/ui/components/radio-group';

import { CHAT_AUDIENCES, ChatActionChoiceSchema, chatExampleOf } from '@/components/chat-commands/chat-commands';
import { ChatCommandSettingsSchema, type ChatCommandSettingsInput, type ChatCommandSettings } from '@/forms/schemas';
import { SelectField } from '@/forms/select-field';
import { TextField } from '@/forms/text-field';
import { useOrganisationId } from '@/hooks/use-organisation';
import { cameraListQueryOptions } from '@/queries/cameras';

export interface ChatCommandFormProps {
  /** What the form starts from: a new command's defaults, or a stored command's settings. */
  defaultValues: ChatCommandSettingsInput;
  /** Called with the command as the API takes it, once the form is sent and valid. */
  onSubmit: (command: ChatCommandSettings) => void;
  /** What follows the fields: why it was refused, and the button that sends it. */
  children: ReactNode;
}

/**
 * A chat command's form, for adding one and for changing one: the word it is used by, who may use it, how long it
 * rests, and what it does. A command that points a camera at a preset names the camera and the preset itself, or
 * leaves either to the words that follow it in chat; a command for the show its output follows takes everything from
 * chat, so it has nothing more to fill in. Beneath the fields, how the command is then typed. The organisation's
 * cameras, for the choices and the example, come from the query cache.
 */
export const ChatCommandForm: FC<ChatCommandFormProps> = ({ defaultValues, onSubmit, children }) => {
  const organisationId = useOrganisationId();
  const camerasQuery = useSuspenseQuery(cameraListQueryOptions(organisationId));
  const cameras = camerasQuery.data;
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
              placeholder="ptz"
              description="The word viewers type after ! in chat."
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
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
        <form.Field name="kind">{field => <ChatActionField field={field} />}</form.Field>
        <form.Subscribe selector={state => state.values}>
          {values => {
            if (values.kind === 'reply') {
              return (
                <form.Field name="text">
                  {field => <TextField field={field} label="What it says" placeholder="The feeder is filled at 8am." />}
                </form.Field>
              );
            }
            // A show command takes everything it acts on from chat.
            if (values.kind !== 'cameraPreset') return null;
            return (
              <>
                <form.Field name="cameraId">{field => <ChatCameraField field={field} cameras={cameras} />}</form.Field>
                <div className="grid grid-cols-2 items-start gap-4">
                  <form.Field name="presetSource">
                    {field => (
                      <SelectField field={field} label="Preset">
                        <NativeSelectOption value="chat">Named in chat</NativeSelectOption>
                        <NativeSelectOption value="named">Always the same one</NativeSelectOption>
                      </SelectField>
                    )}
                  </form.Field>
                  {values.presetSource === 'named' && (
                    <form.Field name="preset">
                      {field => (
                        <ChatPresetField field={field} camera={cameras.find(camera => camera.id === values.cameraId)} />
                      )}
                    </form.Field>
                  )}
                </div>
              </>
            );
          }}
        </form.Subscribe>
        <form.Subscribe selector={state => state.values}>
          {values => (
            <FieldDescription>
              Typed in chat as <code className="font-mono text-foreground">{chatExampleOf(values, cameras)}</code>
            </FieldDescription>
          )}
        </form.Subscribe>
        {children}
      </FieldGroup>
    </form>
  );
};

interface ChatFieldProps {
  field: AnyFieldApi;
}

/** What the command does, as a card for each: choosing one swaps the fields below it. */
const ChatActionField: FC<ChatFieldProps> = ({ field }) => {
  return (
    <FieldSet>
      <FieldLegend variant="label">What it does</FieldLegend>
      <RadioGroup
        className="grid-cols-2"
        value={field.state.value}
        onValueChange={value => {
          const choice = ChatActionChoiceSchema.safeParse(value);
          if (choice.success) field.handleChange(choice.data);
        }}
      >
        <FieldLabel htmlFor="action-cameraPreset">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Camera preset</FieldTitle>
              <FieldDescription>Points a camera at one of its presets.</FieldDescription>
            </FieldContent>
            <RadioGroupItem id="action-cameraPreset" value="cameraPreset" />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="action-reply">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Reply</FieldTitle>
              <FieldDescription>Says something in chat.</FieldDescription>
            </FieldContent>
            <RadioGroupItem id="action-reply" value="reply" />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="action-showSwap">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Swap cameras</FieldTitle>
              <FieldDescription>Swaps two cameras in the show, by position or name.</FieldDescription>
            </FieldContent>
            <RadioGroupItem id="action-showSwap" value="showSwap" />
          </Field>
        </FieldLabel>
        <FieldLabel htmlFor="action-showTakeover">
          <Field orientation="horizontal">
            <FieldContent>
              <FieldTitle>Take over</FieldTitle>
              <FieldDescription>Puts one stream on the whole screen, or ends it with off.</FieldDescription>
            </FieldContent>
            <RadioGroupItem id="action-showTakeover" value="showTakeover" />
          </Field>
        </FieldLabel>
      </RadioGroup>
    </FieldSet>
  );
};

interface ChatCameraFieldProps extends ChatFieldProps {
  cameras: Camera[];
}

/** Which camera the command points: one of the organisation's, or whichever chat names after the command. */
const ChatCameraField: FC<ChatCameraFieldProps> = ({ field, cameras }) => {
  return (
    <SelectField
      field={field}
      label="Camera"
      description="Named in chat, a camera is found by its name or any of its aliases."
    >
      <NativeSelectOption value="">Named in chat</NativeSelectOption>
      {cameras.map(camera => (
        <NativeSelectOption key={camera.id} value={camera.id}>
          {camera.device?.name ?? 'Unnamed camera'}
        </NativeSelectOption>
      ))}
    </SelectField>
  );
};

interface ChatPresetFieldProps extends ChatFieldProps {
  /** The camera the command names, if it names one: its presets are the choices. */
  camera: Camera | undefined;
}

/**
 * The preset the command always goes to. With a camera chosen that has presets, one of them, or whatever the command
 * already named; otherwise typed, since a camera named in chat is not known until then.
 */
const ChatPresetField: FC<ChatPresetFieldProps> = ({ field, camera }) => {
  if (!camera || camera.presets.length === 0) {
    return (
      <TextField
        field={field}
        label="Called"
        placeholder="home"
        description={camera ? 'This camera has no presets yet.' : undefined}
        autoComplete="off"
      />
    );
  }
  const named: string = field.state.value;
  const known = camera.presets.some(preset => preset.name === named);
  return (
    <SelectField field={field} label="Called">
      {!known && (
        <NativeSelectOption value={named} disabled={named === ''}>
          {named === '' ? 'Choose a preset' : `${named} (not one of its presets)`}
        </NativeSelectOption>
      )}
      {camera.presets.map(preset => (
        <NativeSelectOption key={preset.id} value={preset.name}>
          {preset.name}
        </NativeSelectOption>
      ))}
    </SelectField>
  );
};
