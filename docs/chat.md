# Chat commands: standard commands and control channels

Viewers control a broadcast from Twitch chat. Every organisation has the **standard commands**, for every camera,
with nothing to register. They follow
[Alveus Sanctuary's documented commands](https://www.alveussanctuary.org/commands) wherever this system has what they
act on, by the same words and aliases. An organisation's **own commands** only reply. The agent of an output listens
to the chat of its **control channels**: the Twitch channels it goes out to, and any added for it.

## Decisions

| Question                         | Decision                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Where the standard commands live | In code: `packages/chat/src/standard.ts`, shared by the studio API and the agent.                             |
| What an organisation can change  | Per command: on or off, its audience, its cooldown (`chat_command_setting`). No row means as it comes.        |
| What a cooldown is counted per   | A camera command per camera; a layout or audio command per show (`chat_command_turn`). Own commands: whole.   |
| What own commands do             | Reply. Their word may not be a standard command's name or alias.                                              |
| How a camera is named            | Its name or an alias, or a position in the lineup of the show the output follows (`1` is the largest slot).   |
| Which chat controls an output    | The Twitch channels it has an enabled forward to, and its control channels (`output_control_channel`).        |
| A control channel's replies      | Said there as its broadcaster when its Twitch connection may chat; otherwise the command still runs, quietly. |

## The commands

`<x>` is required, `[x]` optional, `a|b` either. Zoom and focus are percentages: absolute ones from 0 (widest,
nearest) to 100. A relative zoom is around 100, as Alveus has it: `150` zooms in by half the camera's range, `50` out
by half. Volumes are percentages of standard volume (100 is 0 dB, up to the mix's +12 dB).

| Group  | Command                                         | Does                                                                                 | Audience as it comes |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------- |
| camera | `!ptzhome <camera>`                             | Points it at its preset named `home`                                                 | subscriber           |
| camera | `!ptzload <camera> <preset>`                    | Points it at a preset                                                                | subscriber           |
| camera | `!ptzlist <camera>`                             | Says its presets                                                                     | subscriber           |
| camera | `!ptzpan`, `!ptztilt <camera> <degrees>`        | Pans or tilts by degrees (`moveBy`)                                                  | moderator            |
| camera | `!ptzzoom <camera> <zoom>`                      | Zooms, around 100                                                                    | moderator            |
| camera | `!ptzset <camera> <pan> <tilt> <zoom>`          | All three relative, at once                                                          | moderator            |
| camera | `!ptzseta <camera> <pan> <tilt> <zoom> [focus]` | Absolute (`moveTo`)                                                                  | moderator            |
| camera | `!ptzmove <camera> <up…downright>`              | A 10° step in a direction                                                            | moderator            |
| camera | `!ptzcenter <camera> <x> <y> [zoom]`            | Centres on a point of the picture (`moveToPoint`), then zooms if asked               | moderator            |
| camera | `!ptzfocusa <camera> <focus>`                   | Absolute focus                                                                       | moderator            |
| layout | `!swap <a> <b>`                                 | Swaps two streams' places, by name or position                                       | moderator            |
| layout | `!slots <0-6>`                                  | Sets the layout by how many slots it has (0 to 6)                                    | moderator            |
| layout | `!scenecams`                                    | Says what is at each position on screen, or what has taken over                      | subscriber           |
| layout | `!takeover <stream\|off>`                       | One stream on air on its own, or back to the layout (ours, not Alveus's)             | moderator            |
| layout | `!livecams`                                     | Ends a takeover                                                                      | moderator            |
| audio  | `!mute`, `!unmute <camera\|all>`                | A stream's channel; `all`, every stream in the lineup (and the show's own on unmute) | moderator            |
| audio  | `!setvolume <camera> <volume>`                  | A stream's level, as `20·log10(v/100)` dB                                            | moderator            |
| audio  | `!getvolume [camera\|all]`                      | Says a stream's volume, or every one's in the lineup                                 | subscriber           |
| audio  | `!resetvolume`                                  | Every stream in the lineup back to standard volume, unmuted                          | moderator            |

Each rests 5 seconds as it comes. `!slots` is ours, in place of Alveus's `!customcams`: the lineup's order is set with
`!swap`, and the layout by its number of slots (docs/shows.md, Layouts).

Left out, since nothing here backs them: continuous moves (`!ptzspin`, `!ptzcfocus`: a drive has to be repeated to keep
going), what needs the camera's live position (`!ptzgetinfo`, `!ptzsave`, relative `!ptzfocus`), saved layouts
(`!camload`, `!camsave`), `!customcams` and its picture-in-picture forms, BRB and scenes, music, feeders and overlays,
and the locks (`!lockcam` and the rest: a command's audience does that, and a `locked` camera here is one switched off).
IR, autofocus and wipers are each driver's own options and actions (packages/cameras), not yet named for chat.

## A use

The agent hears `!word` in a control channel's chat. It drops a use by someone outside the command's audience, or of
a command resting where the studio API last said. Otherwise it tells the studio API by the word
(`organisations.chatCommands.uses.create`), and the API decides it all again (apps/studio/api/src/chat/decide.ts):

1. The command: one of the organisation's own by its word, or a standard one by its name or alias that the
   organisation has on.
2. The viewer is in its audience.
3. Its words name what it acts on (src/chat/cameras.ts, src/chat/shows.ts): `unresolved` otherwise, said only to a
   moderator or the broadcaster.
4. There is something to act with: an agent that reaches the camera, or a show the output follows (`unavailable`).
5. Its turn is taken on its target, in one conditional upsert, so two uses at once cannot both take it (`resting`).
6. A reply is said, or the show is changed in the transaction that holds its row and poked after (`ran`); or grants
   are signed for each of the camera's commands (`planned`), which the agent carries in order and settles
   (`organisations.chatCommands.uses.settle`). A turn whose move wasn't carried is given back.

The agent keeps a standard command's spacing per `name` and, for a camera command, its first word lowercased, which
is close to the API's per-camera rest without resolving names. Agents built before the standard commands still tell
of own commands by ID (`organisations.chatCommands.trigger` v1), decided the same way.

## Operations

| Operation                                         | What                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| `organisations.chatCommands.standard.list` v1     | The standard commands, as the organisation has them (members)                 |
| `organisations.chatCommands.standard.update` v1   | On or off, audience, cooldown (administrators)                                |
| `organisations.chatCommands.standard.reset` v1    | Back as it comes (administrators)                                             |
| `organisations.chatCommands.uses.create` v1       | An output's agent says a command was used, by its word                        |
| `organisations.chatCommands.uses.settle` v1       | That agent says what came of a planned use                                    |
| `organisations.outputs.controlChannels.create` v1 | A Twitch channel's chat controls the output, whether or not it goes out there |
| `organisations.outputs.controlChannels.delete` v1 | It no longer does                                                             |

`organisations.chatCommands.{list,get,create,update}` v2 take and return replies alone; `create` and `update` v1,
which took camera commands, are retired. `organisations.outputs.{list,get}` v2 carry `controlChannels`, and
`deviceConfiguration.get` v4's `chat` lists the `standard` commands the organisation has on.
