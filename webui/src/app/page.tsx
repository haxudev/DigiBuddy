"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { HttpAgent, type Message } from "@ag-ui/client";
import AgentCapabilities from "@/components/AgentCapabilities";
import ArtifactWindow from "@/components/ArtifactWindow";
import ActivityTrail from "@/components/ActivityTrail";
import AskUserCard from "@/components/AskUserCard";
import CopyButton from "@/components/CopyButton";
import Markdown from "@/components/Markdown";
import SessionSidebar from "@/components/SessionSidebar";
import SignIn from "@/components/SignIn";
import SuggestionMenu, {
  suggestionOptionId,
  type SuggestionItem,
  type SuggestionStatus,
} from "@/components/SuggestionMenu";
import VoiceInputButton from "@/components/VoiceInputButton";
import {
  ACTIVITY_EVENT_NAME,
  isActivityEvent,
  reduceActivity,
  settleActivity,
  type ActivityEntry,
} from "@/lib/activity";
import { REASONING_EFFORTS, type TurnAttachment } from "@/lib/agent-proxy";
import {
  deliveryFailures,
  extractArtifacts,
  stripArtifactMetadata,
  type Artifact,
} from "@/lib/artifacts";
import {
  extractEffectiveProfile,
  stripProfileMetadata,
} from "@/lib/effective-profile";
import {
  leadingMention,
  matchProfiles,
  mentionQuery,
  resolveMention,
  stripMention,
} from "@/lib/mentions";
import {
  commandQuery,
  commandSkills,
  exceedsSkillLimit,
  isCommandSelected,
  leadingCommand,
  matchCommands,
  MAX_COMMAND_SKILLS,
  resolveCommand,
  stripCommand,
  toggleCommand,
  type SkillCommand,
} from "@/lib/skill-commands";
import { splitMessage } from "@/lib/ask-user";
import {
  dropSession,
  finishRun,
  forSession,
  isRunning as sessionIsRunning,
  runState,
  setForSession,
  startRun,
  type RunStates,
} from "@/lib/session-runs";
import {
  deliveryFocus,
  shouldOpenDeliverables,
  type DeliveryFocus,
} from "@/lib/deliverables";
import {
  DEFAULT_PANEL_WIDTH,
  clampPanelWidth,
  deliverablesUseGridTrack,
  sharedDeliverablesWidth,
} from "@/lib/deliverables-panel";
import type { ProfileCapabilities } from "@/lib/profile-capabilities";
import { clampActive, isSuggestionKey, moveActive } from "@/lib/suggestions";
import {
  getServerSessions,
  getSession,
  getSessions,
  replaceSessions,
  setSessionOwner,
  subscribeSessions,
  updateSession,
} from "@/lib/session-store";
import {
  StoredMessage,
  createSession,
  deriveTitle,
  removeSession,
  renameSession,
  upsertSession,
} from "@/lib/sessions";
import styles from "./page.module.css";

const EFFORT_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

/** Stable empty list, so a menu with nothing in it does not rerender the page. */
const EMPTY_COMMANDS: SkillCommand[] = [];

/**
 * Stable empties for the per-session stores.
 *
 * Identity matters here: these feed `useMemo` dependencies and component
 * props, and a fresh `[]` per render would rerender the transcript on every
 * keystroke.
 */
const EMPTY_ACTIVITY: ActivityEntry[] = [];
const EMPTY_SELECTION: SkillCommand[] = [];
const EMPTY_TURN_COMMANDS: Record<string, string[]> = {};

/** What the composer will accept, matching the formats Codex can open. */
const ATTACHMENT_ACCEPT =
  "image/*,.pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json";

function readAsDataUrl(file: File): Promise<TurnAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () =>
      resolve({
        filename: file.name,
        mimeType: file.type,
        data: String(reader.result ?? ""),
      });
    reader.readAsDataURL(file);
  });
}

function messageText(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) =>
        typeof item === "object" && item && "text" in item
          ? String(item.text)
          : "",
      )
      .join("");
  }
  return "";
}

function toStoredMessages(messages: Message[]): StoredMessage[] {
  return messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => ({
      id: message.id,
      role: message.role as StoredMessage["role"],
      content: messageText(message),
    }))
    .filter((message) => message.content.trim());
}

/**
 * An answer as plain text, for the clipboard.
 *
 * Structured questions are rendered as a card rather than as their fenced JSON,
 * so copying the raw message would hand over a block of markup the reader never
 * saw. The question is copied instead, which is what was on screen.
 */
function copyableAnswer(cleaned: string, messageId: string): string {
  return splitMessage(cleaned, messageId)
    .map((segment) =>
      segment.kind === "ask" ? segment.request.question : segment.text,
    )
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

export default function Home() {
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  /**
   * Which conversations have a turn in flight, keyed by session id.
   *
   * A run belongs to its conversation, not to the page. The console used to
   * hold a single `isRunning` next to a single agent, which forced switching
   * sessions to abort whatever was running -- clicking away from a question
   * killed the answer to it.
   */
  const [runs, setRuns] = useState<RunStates>({});
  const [profiles, setProfiles] = useState<ProfileCapabilities[]>([]);
  // `null` while the answer is unknown, so the console does not flash a
  // sign-in screen at someone who is already signed in.
  const [identity, setIdentity] = useState<{
    signedIn: boolean;
    providers: string[];
    corporateOnly: boolean;
    rejected: boolean;
    reason: string;
  } | null>(null);
  /** Thinking and tool rows, per conversation, so a switch does not lose them. */
  const [activityBySession, setActivityBySession] = useState<
    Record<string, ActivityEntry[]>
  >({});
  const [attachments, setAttachments] = useState<TurnAttachment[]>([]);
  const [reasoningEffort, setReasoningEffort] = useState("");
  /**
   * The skill menu, and which agent it describes.
   *
   * The two travel together because a catalogue fetched for the previous agent
   * is not an answer about this one, and showing it as if it were would offer
   * a skill the runtime would then refuse. Whether the catalogue could be read
   * at all travels with it too: an empty menu and an unreachable configuration
   * store are different answers, and showing the second as the first is what
   * made `/` look like a keystroke that does nothing.
   */
  const [commandCatalogue, setCommandCatalogue] = useState<{
    profile: string;
    status: "ready" | "unavailable";
    commands: SkillCommand[];
  } | null>(null);
  /**
   * The open menu's highlight, and the token it belongs to.
   *
   * Keyed by the token so a new query resets both the highlight and a menu
   * dismissed with Escape, without an effect having to notice and correct it
   * after the fact.
   */
  const [suggestion, setSuggestion] = useState({
    token: "",
    active: 0,
    dismissed: false,
  });
  /** Deliveries the runtime could not save, dismissed by the reader. */
  const [dismissedFailures, setDismissedFailures] = useState<string[]>([]);
  /**
   * The skills chosen for the next message, per conversation.
   *
   * One message, not the conversation. A skill is markdown the model reads on
   * demand, so unlike the agent it can be chosen per turn -- and pretending
   * otherwise would either lie about the scope or force a new conversation for
   * every command.
   *
   * Several at once, because a turn may legitimately need more than one: the
   * runtime accepts up to `MAX_COMMAND_SKILLS`, and a curated command already
   * bundles two or three. Keyed by session so an armed skill stays with the
   * conversation it was armed in.
   */
  const [pendingBySession, setPendingBySession] = useState<
    Record<string, SkillCommand[]>
  >({});
  /** Why a skill could not be added, said next to the chips rather than as an error. */
  const [skillNotice, setSkillNotice] = useState("");
  const [pendingTurn, setPendingTurn] = useState<{
    sessionId: string;
    text: string;
    profile: string;
  } | null>(null);
  const pendingVoiceTurnsRef = useRef<
    { id: string; sessionId: string; text: string }[]
  >([]);
  // On phones and tablets the sidebar slides over the conversation instead of
  // squeezing it, and so does the deliverables column.
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  /**
   * Width of the deliverables column, owned here because it is a grid track.
   *
   * The panel is the thing that gets dragged, but the track it occupies is
   * declared on the shell, so the number has to live above both. It starts at
   * the default and the panel replaces it with the remembered one once it is
   * on a client.
   */
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  /**
   * One live agent per conversation, kept for as long as the conversation is.
   *
   * This is deliberately not tied to which session is on screen. An effect that
   * created the agent on `activeId` had to tear it down again on the way out,
   * and tearing it down meant `abortRun()`: switching sessions killed the turn
   * you had just sent. Agents are released when the conversation is deleted,
   * when the signed-in account changes, and when the console unmounts.
   */
  const agentsRef = useRef(
    new Map<string, { agent: HttpAgent; subscription: { unsubscribe(): void } }>(),
  );
  const shellRef = useRef<HTMLElement | null>(null);
  const chatRef = useRef<HTMLElement | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const getDeliverablesAvailableWidth = useCallback(() => {
    if (typeof window === "undefined") return null;
    if (!deliverablesUseGridTrack(window.innerWidth)) return null;
    const shell = shellRef.current;
    const chat = chatRef.current;
    if (!shell || !chat) return null;
    return sharedDeliverablesWidth(
      shell.getBoundingClientRect().right,
      chat.getBoundingClientRect().left,
    );
  }, []);

  /*
   * The shell's third grid track is a fixed pixel value, so a remembered width
   * from a large monitor can become impossible after the viewport shrinks.
   * Re-clamping while the docked panel is open keeps the persisted preference
   * and the live CSS variable inside the space left after the sessions column.
   */
  useEffect(() => {
    if (!panelOpen) return;
    function reclampPanelWidth() {
      const available = getDeliverablesAvailableWidth();
      if (available === null) return;
      setPanelWidth((current) => clampPanelWidth(current, available));
    }
    reclampPanelWidth();
    window.addEventListener("resize", reclampPanelWidth);
    return () => window.removeEventListener("resize", reclampPanelWidth);
  }, [getDeliverablesAvailableWidth, panelOpen]);

  // Sessions live in browser storage: the Responses API keeps each transcript
  // server side behind a response id, but the console needs its own history.
  const sessions = useSyncExternalStore(
    subscribeSessions,
    getSessions,
    getServerSessions,
  );

  const activeSession =
    sessions.find((session) => session.id === selectedId) ?? sessions[0];
  const activeId = activeSession?.id ?? "";
  // The agent is a property of the conversation, not of the page: switching
  // sessions must follow it, and a reload must restore it.
  const requestedProfile = activeSession?.requestedProfile ?? "";
  const boundProfile = activeSession?.boundProfile ?? "";

  // Each session owns an agent so switching never mixes transcripts or reuses
  // another session's previous response id. The agent outlives the view: it is
  // created on demand and only released when its conversation goes away.
  const ensureAgent = useCallback((sessionId: string): HttpAgent | null => {
    if (!sessionId) return null;
    const existing = agentsRef.current.get(sessionId);
    if (existing) return existing.agent;
    const session = getSession(sessionId);
    if (!session) return null;

    const agent = new HttpAgent({
      url: "/api/agent",
      threadId: session.threadId,
      initialMessages: session.messages.map((message) => ({ ...message })),
      initialState: { previousResponseId: session.previousResponseId },
    });

    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        // Thinking and tool rows arrive out of band so they never enter the
        // transcript the console stores and mines for deliverables.
        if (event.name !== ACTIVITY_EVENT_NAME) return;
        if (!isActivityEvent(event.value)) return;
        const activityEvent = event.value;
        setActivityBySession((current) =>
          setForSession(
            current,
            sessionId,
            reduceActivity(
              forSession(current, sessionId, EMPTY_ACTIVITY),
              activityEvent,
            ),
          ),
        );
      },
      onMessagesChanged: ({ messages: nextMessages }) => {
        const stored = toStoredMessages(nextMessages as Message[]);
        // The runtime is the authority on which agent ran, so the binding is
        // taken from its answer rather than from what this client asked for.
        const reported = stored
          .filter((message) => message.role === "assistant")
          .map((message) => extractEffectiveProfile(message.content))
          .filter((entry) => entry !== null)
          .pop();
        updateSession(sessionId, (item) => ({
          ...item,
          messages: stored,
          boundProfile: reported ? reported.profile : item.boundProfile,
          title: item.title === "New session" ? deriveTitle(stored) : item.title,
          updatedAt: Date.now(),
        }));
      },
      onStateChanged: ({ state }) => {
        const responseId =
          state && typeof state === "object" && "previousResponseId" in state
            ? String((state as Record<string, unknown>).previousResponseId ?? "")
            : "";
        if (!responseId) return;
        updateSession(sessionId, (item) => ({
          ...item,
          previousResponseId: responseId,
        }));
      },
    });

    agentsRef.current.set(sessionId, { agent, subscription });
    return agent;
  }, []);

  /** Stop and forget one conversation's agent, for when it is deleted. */
  const releaseAgent = useCallback((sessionId: string) => {
    const held = agentsRef.current.get(sessionId);
    if (!held) return;
    held.agent.abortRun();
    held.subscription.unsubscribe();
    agentsRef.current.delete(sessionId);
  }, []);

  const releaseAllAgents = useCallback(() => {
    for (const sessionId of [...agentsRef.current.keys()]) releaseAgent(sessionId);
  }, [releaseAgent]);

  // Opening a conversation gives it an agent; leaving it does not take it away.
  useEffect(() => {
    ensureAgent(activeId);
  }, [activeId, ensureAgent, sessions]);

  // Every agent holds an open request, so the console must let go of them when
  // it goes away.
  useEffect(() => () => releaseAllAgents(), [releaseAllAgents]);

  const isRunning = sessionIsRunning(runs, activeId);
  const runStartedAt = runState(runs, activeId).startedAt;
  const activity = forSession(activityBySession, activeId, EMPTY_ACTIVITY);
  const pendingCommands = forSession(pendingBySession, activeId, EMPTY_SELECTION);
  const turnCommands = activeSession?.turnCommands ?? EMPTY_TURN_COMMANDS;
  const runningIds = useMemo(
    () => Object.keys(runs).filter((sessionId) => runs[sessionId].running),
    [runs],
  );

  // Conversations are namespaced per account, so the store has to know which
  // account this is before anything reads or writes it.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : {
              signedIn: false,
              providers: [],
              corporateOnly: false,
              rejected: false,
              reason: "",
            },
      )
      .then((me) => {
        // The anonymous namespace may already have handed out an agent bound to
        // a thread that is not this account's, so those are dropped before the
        // store is repointed rather than left to answer into someone else's
        // conversation.
        releaseAllAgents();
        setSessionOwner(me.signedIn ? String(me.owner ?? "") : "");
        setIdentity({
          signedIn: Boolean(me.signedIn),
          providers: Array.isArray(me.providers) ? me.providers : [],
          corporateOnly: Boolean(me.corporateOnly),
          rejected: Boolean(me.rejected),
          reason: String(me.reason ?? ""),
        });
      })
      // A deployment with no auth in front of it still has to be usable, and
      // the server refuses unauthenticated work regardless of what is shown.
      .catch(() =>
        setIdentity({
          signedIn: true,
          providers: [],
          corporateOnly: false,
          rejected: false,
          reason: "",
        }),
      );
    return () => controller.abort();
  }, [releaseAllAgents]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/profiles", { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { profiles: [] }))
      .then((payload) => setProfiles(payload.profiles ?? []))
      // No profiles configured simply means the runtime default is used.
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const messages = useMemo(() => activeSession?.messages ?? [], [activeSession]);

  // Commands depend on the agent, because a command is only real when the
  // profile behind the conversation can reach the skills it names.
  const commandProfile = boundProfile || requestedProfile;
  useEffect(() => {
    const controller = new AbortController();
    const query = commandProfile
      ? `?profile=${encodeURIComponent(commandProfile)}`
      : "";
    fetch(`/api/commands${query}`, { signal: controller.signal })
      .then((response) =>
        response.ok ? response.json() : { commands: [], status: "unavailable" },
      )
      .then((payload) =>
        setCommandCatalogue({
          profile: commandProfile,
          status: payload.status === "unavailable" ? "unavailable" : "ready",
          commands: payload.commands ?? [],
        }),
      )
      // A menu that cannot be loaded says so; everything else still works.
      .catch((reason) => {
        if (controller.signal.aborted) return;
        console.error("could not load the skill menu", reason);
        setCommandCatalogue({
          profile: commandProfile,
          status: "unavailable",
          commands: [],
        });
      });
    return () => controller.abort();
  }, [commandProfile]);

  // The catalogue records which agent it was fetched for, so a menu for the
  // previous agent is never shown as if it were this one's: until the answer
  // for this agent arrives, the honest state is "still loading".
  const catalogueMatches = commandCatalogue?.profile === commandProfile;
  const commands = catalogueMatches ? commandCatalogue.commands : EMPTY_COMMANDS;
  const commandsStatus: SuggestionStatus = catalogueMatches
    ? commandCatalogue.status
    : "loading";

  // `/` stays meaningful for the whole conversation, unlike `@`: a skill is
  // read per turn, so choosing one later is a promise the runtime can keep.
  const command = commandQuery(prompt);
  const commandMatches = useMemo(
    () => (command ? matchCommands(commands, command.query) : []),
    [command, commands],
  );

  // `@` is meaningful only where it can still change something: the first
  // message of a conversation that has not been bound yet.
  const mention = mentionQuery(prompt);
  const mentionMatches = useMemo(
    () => (mention ? matchProfiles(profiles, mention.query) : []),
    [mention, profiles],
  );

  // A new token is a new list, so the highlight goes back to the top and a
  // menu dismissed for the previous token comes back. Adjusting during the
  // render that noticed is what React recommends over correcting afterwards
  // in an effect, which would show one frame of the stale highlight first.
  const token = command ? `/${command.query}` : mention ? `@${mention.query}` : "";
  if (suggestion.token !== token) {
    setSuggestion({ token, active: 0, dismissed: false });
  }
  const dismissed = suggestion.token === token && suggestion.dismissed;

  // Typing `/` opens the menu, whatever is behind it. A menu that stayed
  // hidden when the catalogue was empty is indistinguishable from a broken
  // keystroke, and gave the reader nothing to act on.
  const commandOpen = command !== null && !dismissed;
  const mentionOpen = mention !== null && !dismissed;

  /**
   * Arm or disarm a skill for the next message in this conversation.
   *
   * Choosing the same command again takes it back off, so the keystroke that
   * armed it is also the one that undoes it. A command that would push the turn
   * past what the runtime carries is refused with a reason rather than accepted
   * and silently trimmed on arrival.
   */
  function chooseCommand(entry: SkillCommand) {
    setPrompt(stripCommand(prompt));
    if (exceedsSkillLimit(pendingCommands, entry)) {
      setSkillNotice(
        `A message can load at most ${MAX_COMMAND_SKILLS} skills. Remove one before adding ${entry.title}.`,
      );
      return;
    }
    setSkillNotice("");
    setPendingBySession((current) =>
      setForSession(
        current,
        activeId,
        toggleCommand(forSession(current, activeId, EMPTY_SELECTION), entry),
      ),
    );
  }

  function removeCommand(name: string) {
    setSkillNotice("");
    setPendingBySession((current) =>
      setForSession(
        current,
        activeId,
        forSession(current, activeId, EMPTY_SELECTION).filter(
          (entry) => entry.name !== name,
        ),
      ),
    );
  }

  const menuItems: SuggestionItem[] = useMemo(() => {
    if (commandOpen) {
      return commandMatches.map((entry) => ({
        key: entry.name,
        title: entry.title,
        description: entry.description || entry.hint,
        token: `/${entry.name}`,
        current: isCommandSelected(pendingCommands, entry.name),
      }));
    }
    if (mentionOpen) {
      return mentionMatches.map((entry) => ({
        key: entry.name,
        title: entry.display_name || entry.name,
        description: entry.description,
        token: `@${entry.name}`,
        current: entry.name === (boundProfile || requestedProfile),
      }));
    }
    return [];
  }, [
    boundProfile,
    commandMatches,
    commandOpen,
    mentionMatches,
    mentionOpen,
    pendingCommands,
    requestedProfile,
  ]);

  const menuOpen = commandOpen || mentionOpen;
  // The list is refiltered on every keystroke, so the remembered highlight
  // regularly points past the end of the list actually on screen.
  const highlighted = clampActive(suggestion.active, menuItems.length);

  function highlight(index: number) {
    setSuggestion((current) => ({ ...current, token, active: index }));
  }

  function chooseSuggestion(index: number) {
    const item = menuItems[index];
    if (!item) return;
    if (commandOpen) {
      const entry = commands.find((candidate) => candidate.name === item.key);
      if (entry) chooseCommand(entry);
      return;
    }
    chooseMention(item.key);
  }

  function chooseMention(name: string) {
    const rest = stripMention(prompt);
    setPrompt(rest);
    if (boundProfile) {
      // The runtime keeps the agent this conversation started with, so the
      // only honest way to reach another one is a new conversation.
      createNewSession(name);
    } else {
      updateSession(activeId, (item) => ({ ...item, requestedProfile: name }));
    }
  }


  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, activity]);

  const artifacts = useMemo<Artifact[]>(
    () =>
      messages
        .filter((message) => message.role === "assistant")
        .flatMap((message) => extractArtifacts(message.content, message.id)),
    [messages],
  );

  // A generated file is only delivered once the reader can see it, so a new
  // deliverable opens the window itself instead of waiting to be discovered
  // behind a header button.
  const deliveryRef = useRef<DeliveryFocus>({ session: "", latest: "" });
  useEffect(() => {
    const next = deliveryFocus(
      activeSession?.id ?? "",
      artifacts.map((artifact) => artifact.id),
    );
    const previous = deliveryRef.current;
    deliveryRef.current = next;
    if (shouldOpenDeliverables(previous, next)) setPanelOpen(true);
  }, [artifacts, activeSession?.id]);

  /**
   * Deliverables the runtime could not save, per message.
   *
   * The count rides in the same invisible manifest the artifacts do, so it is
   * shown once as a notice the reader can dismiss rather than written into the
   * answer, where a transient storage outage used to live forever.
   */
  const failedDeliveries = useMemo(
    () =>
      messages
        .filter((message) => message.role === "assistant")
        .map((message) => ({
          id: message.id,
          failed: deliveryFailures(message.content),
        }))
        .filter((entry) => entry.failed > 0 && !dismissedFailures.includes(entry.id)),
    [dismissedFailures, messages],
  );

  /**
   * Send one turn, in a named conversation.
   *
   * The session is a parameter rather than "whichever is on screen", because
   * the two are no longer the same thing: a turn keeps running while the reader
   * looks at another conversation, and `@agent` starts a new conversation and
   * sends into it before the view has caught up.
   */
  const send = useCallback(
    async (
      sessionId: string,
      value: string,
      profileOverride = "",
      withCommands?: SkillCommand[],
      detachedFromComposer = false,
    ) => {
      const text = value.trim();
      if (!text) return;
      if (sessionIsRunning(runs, sessionId)) return;
      const agent = ensureAgent(sessionId);
      if (!agent) {
        setError("The conversation is still loading. Try sending again.");
        return;
      }
      const session = getSession(sessionId);

      setError("");
      setSkillNotice("");
      setActivityBySession((current) => setForSession(current, sessionId, []));
      setRuns((current) => startRun(current, sessionId, Date.now()));

      // The id is minted here rather than left to the agent, so the skills this
      // turn was sent with can be recorded against the message they belong to.
      const messageId = crypto.randomUUID();
      const chosen =
        withCommands ??
        (detachedFromComposer
          ? EMPTY_SELECTION
          : forSession(pendingBySession, sessionId, EMPTY_SELECTION));
      agent.addMessage({ id: messageId, role: "user", content: text });
      if (chosen.length > 0) {
        updateSession(sessionId, (item) => ({
          ...item,
          turnCommands: {
            ...item.turnCommands,
            [messageId]: chosen.map((entry) => entry.name),
          },
        }));
      }

      // Files belong to the turn that sends them, so the tray empties as soon
      // as the request is on its way.
      const files = detachedFromComposer ? [] : attachments;
      if (!detachedFromComposer) setAttachments([]);
      // So do the skills. They were chosen for this message, and leaving them
      // set would silently apply them to the next one too.
      if (!detachedFromComposer) {
        setPendingBySession((current) => dropSession(current, sessionId));
      }

      try {
        await agent.runAgent({
          forwardedProps: {
            // A bound conversation keeps its agent whatever the picker shows,
            // because the runtime will keep it regardless.
            connection: {
              profile:
                profileOverride ||
                session?.boundProfile ||
                session?.requestedProfile ||
                "",
            },
            attachments: files,
            reasoningEffort,
            skills: commandSkills(chosen),
            // The runtime's directive cites one command by name; the full set
            // of skills travels in `skills`.
            command: chosen[0]?.name ?? "",
          },
        });
      } catch (runError) {
        setError(
          runError instanceof Error ? runError.message : "Agent request failed",
        );
      } finally {
        setActivityBySession((current) =>
          setForSession(
            current,
            sessionId,
            settleActivity(forSession(current, sessionId, EMPTY_ACTIVITY)),
          ),
        );
        setRuns((current) => finishRun(current, sessionId));
      }
    },
    [
      attachments,
      ensureAgent,
      pendingBySession,
      reasoningEffort,
      runs,
    ],
  );

  useEffect(() => {
    if (
      !pendingTurn ||
      pendingTurn.sessionId !== activeId ||
      !agentsRef.current.has(activeId) ||
      sessionIsRunning(runs, activeId)
    ) {
      return;
    }
    setPendingTurn(null);
    void send(pendingTurn.sessionId, pendingTurn.text, pendingTurn.profile);
  }, [activeId, pendingTurn, runs, send]);

  useEffect(() => {
    const ready = pendingVoiceTurnsRef.current.find(
      (turn) => !sessionIsRunning(runs, turn.sessionId),
    );
    if (!ready) return;
    pendingVoiceTurnsRef.current = pendingVoiceTurnsRef.current.filter(
      (turn) => turn.id !== ready.id,
    );
    void send(ready.sessionId, ready.text, "", EMPTY_SELECTION, true);
  }, [runs, send]);

  async function addFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    try {
      const read = await Promise.all(files.map(readAsDataUrl));
      setAttachments((current) => [...current, ...read]);
    } catch (readError) {
      setError(
        readError instanceof Error ? readError.message : "Could not read the file.",
      );
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const invoked = leadingCommand(prompt);
    if (invoked) {
      const resolved = resolveCommand(commands, invoked.query);
      if (!resolved) {
        setError(
          commandsStatus === "unavailable"
            ? "The skill catalogue could not be loaded, so /commands are unavailable. Send the message without one, or ask an administrator to check the configuration store."
            : `No skill matches /${invoked.query}.`,
        );
        return;
      }
      // `/command` on its own arms the skill and waits: the command says which
      // skill to use, not what to do with it.
      if (!invoked.message) {
        chooseCommand(resolved);
        return;
      }
      // `/command message` sends with that skill on top of anything already
      // armed, because the chips and the typed token are the same choice made
      // two ways.
      if (
        !isCommandSelected(pendingCommands, resolved.name) &&
        exceedsSkillLimit(pendingCommands, resolved)
      ) {
        setSkillNotice(
          `A message can load at most ${MAX_COMMAND_SKILLS} skills. Remove one before adding ${resolved.title}.`,
        );
        return;
      }
      setError("");
      setSkillNotice("");
      setPrompt("");
      void send(
        activeId,
        invoked.message,
        "",
        isCommandSelected(pendingCommands, resolved.name)
          ? pendingCommands
          : [...pendingCommands, resolved],
      );
      return;
    }
    const addressed = leadingMention(prompt);
    if (addressed) {
      const resolved = resolveMention(profiles, addressed.query);
      if (!resolved) {
        setError(`No agent matches @${addressed.query}.`);
        return;
      }
      if (!addressed.message) {
        chooseMention(resolved.name);
        return;
      }

      setError("");
      setPrompt("");
      if (boundProfile && boundProfile !== resolved.name) {
        const sessionId = createNewSession(resolved.name);
        setPendingTurn({
          sessionId,
          text: addressed.message,
          profile: resolved.name,
        });
        return;
      }
      if (!boundProfile) {
        updateSession(activeId, (item) => ({
          ...item,
          requestedProfile: resolved.name,
        }));
      }
      void send(activeId, addressed.message, resolved.name);
      return;
    }
    if (!activeId) {
      setError("The conversation is still loading. Try sending again.");
      return;
    }
    const value = prompt;
    setPrompt("");
    void send(activeId, value);
  }

  function selectSession(sessionId: string) {
    setSelectedId(sessionId);
    setError("");
    setSkillNotice("");
    setNavOpen(false);
    setPanelOpen(false);
    // Activity, the run and any armed skill stay with the conversation they
    // belong to. They used to be cleared here, because there was only one of
    // each -- which is the same reason switching used to abort the run.
  }

  function createNewSession(withProfile = ""): string {
    const session = createSession(withProfile);
    replaceSessions(upsertSession(sessions, session));
    selectSession(session.id);
    return session.id;
  }

  function deleteSession(sessionId: string) {
    // The agent holds an open request against a thread that is about to stop
    // existing, so this is the one place a run is deliberately cut short.
    releaseAgent(sessionId);
    setRuns((current) => dropSession(current, sessionId));
    setActivityBySession((current) => dropSession(current, sessionId));
    setPendingBySession((current) => dropSession(current, sessionId));
    const remaining = removeSession(sessions, sessionId);
    replaceSessions(remaining);
    if (sessionId === activeId) selectSession(remaining[0]?.id ?? "");
  }

  if (identity && !identity.signedIn) {
    return (
      <SignIn
        providers={identity.providers}
        corporateOnly={identity.corporateOnly}
        rejected={identity.rejected}
        reason={identity.reason}
      />
    );
  }

  return (
    <main
      ref={shellRef}
      className={styles.shell}
      data-nav={navOpen ? "open" : "closed"}
      data-deliverables={panelOpen ? "open" : "closed"}
      style={
        {
          "--deliverables-panel-width": `${panelWidth}px`,
        } as React.CSSProperties
      }
    >
      <div className={styles.navSlot}>
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
          runningIds={runningIds}
          onSelect={selectSession}
          onCreate={() => createNewSession()}
          onRename={(sessionId, title) =>
            replaceSessions(renameSession(sessions, sessionId, title))
          }
          onDelete={deleteSession}
        />
      </div>

      <button
        type="button"
        className={styles.backdrop}
        aria-label="Close navigation"
        onClick={() => {
          setNavOpen(false);
          setPanelOpen(false);
        }}
      />

      <section className={styles.chat} ref={chatRef}>
        <header className={styles.chatHeader}>
          <div>
            <button
              type="button"
              className={styles.drawerButton}
              onClick={() => setNavOpen(true)}
              aria-label="Show sessions"
            >
              ☰
            </button>
            {activeSession?.title ?? ""}
          </div>
          <div className={styles.headerActions}>
            <button
              type="button"
              className={styles.deliverablesButton}
              onClick={() => setPanelOpen((open) => !open)}
              aria-pressed={panelOpen}
              aria-label={panelOpen ? "Hide deliverables" : "Show deliverables"}
            >
              ▤ {artifacts.length}
            </button>
            <AgentCapabilities
              profiles={profiles}
              selected={boundProfile || requestedProfile}
              bound={Boolean(boundProfile)}
              running={isRunning}
              onSelect={(name) =>
                updateSession(activeId, (item) => ({
                  ...item,
                  requestedProfile: name,
                }))
              }
              onStartNewSession={(name: string) => createNewSession(name)}
            />
          </div>
        </header>

        <div className={styles.messages} aria-live="polite" ref={transcriptRef}>
          {messages.length === 0 ? (
            <div className={styles.emptyState}>
              <span>⌁</span>
              <h2>What should GTMBuddy build?</h2>
              <p>
                Analyze a repository, implement a focused change, or run validation
                in the isolated Foundry workspace.
              </p>
            </div>
          ) : (
            messages.map((message) =>
              message.role === "user" ? (
                <article className={styles.userMessage} key={message.id}>
                  <div className={styles.messageHeader}>
                    <small>You</small>
                    <CopyButton value={message.content} label="Copy your message" />
                  </div>
                  {/* The skills this turn was sent with. They never entered the
                      message text, so without this the transcript would not
                      record that a skill was applied at all. */}
                  {(turnCommands[message.id] ?? []).length > 0 && (
                    <ul className={styles.messageSkills}>
                      {turnCommands[message.id].map((name) => (
                        <li key={name}>/{name}</li>
                      ))}
                    </ul>
                  )}
                  <p>{message.content}</p>
                </article>
              ) : (
                <article className={styles.agentMessage} key={message.id}>
                  <div className={styles.messageHeader}>
                    <small>GTMBuddy</small>
                    <CopyButton
                      value={copyableAnswer(
                        stripProfileMetadata(stripArtifactMetadata(message.content)),
                        message.id,
                      )}
                      label="Copy the agent's answer"
                    />
                  </div>
                  {splitMessage(
                    stripProfileMetadata(stripArtifactMetadata(message.content)),
                    message.id,
                  ).map((segment, index) =>
                    segment.kind === "ask" ? (
                      <AskUserCard
                        key={segment.request.id}
                        request={segment.request}
                        disabled={isRunning}
                        onAnswer={(answer) => void send(activeId, answer)}
                      />
                    ) : (
                      <Markdown key={`${message.id}-md-${index}`}>
                        {segment.text}
                      </Markdown>
                    ),
                  )}
                  {failedDeliveries
                    .filter((entry) => entry.id === message.id)
                    .map((entry) => (
                      <div
                        className={styles.deliveryWarning}
                        key={`${entry.id}-delivery`}
                        role="status"
                      >
                        <span aria-hidden="true">⚠</span>
                        <p>
                          {entry.failed === 1
                            ? "One generated file could not be saved to the delivery area."
                            : `${entry.failed} generated files could not be saved to the delivery area.`}{" "}
                          The answer above is unaffected. Ask again to retry the
                          files, or tell an administrator if it keeps happening.
                        </p>
                        <button
                          type="button"
                          aria-label="Dismiss the delivery warning"
                          onClick={() =>
                            setDismissedFailures((current) => [...current, entry.id])
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                </article>
              ),
            )
          )}
          <ActivityTrail
            entries={activity}
            running={isRunning}
            startedAt={runStartedAt}
          />
        </div>

        {error && (
          <div className={styles.error} role="alert">
            <span className={styles.errorIcon} aria-hidden="true">
              !
            </span>
            <div>
              <strong>The agent could not finish this turn</strong>
              <p>{error}</p>
            </div>
            <button type="button" onClick={() => setError("")} aria-label="Dismiss">
              ×
            </button>
          </div>
        )}

        <form className={styles.composer} onSubmit={submit}>
          {commandOpen && (
            <SuggestionMenu
              id="skill-suggestions"
              heading="Skills"
              label="Choose a skill"
              items={menuItems}
              activeIndex={highlighted}
              status={commandsStatus}
              note={
                pendingCommands.length > 0
                  ? `${pendingCommands.length} armed for the next message. Choose more to add them, or choose one again to remove it.`
                  : "A message may load more than one skill."
              }
              emptyMessage={
                commands.length === 0
                  ? "This agent has no skills published yet."
                  : "No skill matches that name."
              }
              unavailableMessage="The skill catalogue could not be loaded. Everything else still works; ask an administrator to check the configuration store."
              onHighlight={highlight}
              onChoose={chooseSuggestion}
            />
          )}
          {mentionOpen && (
            <SuggestionMenu
              id="agent-suggestions"
              heading="Agents"
              label="Choose an agent"
              items={menuItems}
              activeIndex={highlighted}
              status="ready"
              note={
                boundProfile
                  ? `This conversation runs ${
                      profiles.find((entry) => entry.name === boundProfile)
                        ?.display_name ?? boundProfile
                    }. Choosing another agent starts a new conversation.`
                  : undefined
              }
              emptyMessage="No agent matches that name."
              unavailableMessage="The agent list could not be loaded."
              onHighlight={highlight}
              onChoose={chooseSuggestion}
            />
          )}
          {pendingCommands.length > 0 && (
            <ul className={styles.attachments}>
              {pendingCommands.map((entry) => (
                <li key={entry.name}>
                  <span>
                    /{entry.name}
                    {entry.hint ? ` — ${entry.hint}` : ""}
                  </span>
                  <button
                    type="button"
                    aria-label={`Remove ${entry.title}`}
                    onClick={() => removeCommand(entry.name)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          {skillNotice && (
            <p className={styles.skillNotice} role="status">
              {skillNotice}
            </p>
          )}
          {attachments.length > 0 && (
            <ul className={styles.attachments}>
              {attachments.map((attachment, index) => (
                <li key={`${attachment.filename}-${index}`}>
                  <span>{attachment.filename}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachment.filename}`}
                    onClick={() =>
                      setAttachments((current) =>
                        current.filter((_, position) => position !== index),
                      )
                    }
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            role="combobox"
            aria-expanded={menuOpen}
            aria-controls={
              menuOpen
                ? commandOpen
                  ? "skill-suggestions"
                  : "agent-suggestions"
                : undefined
            }
            aria-activedescendant={
              menuOpen && menuItems.length > 0
                ? suggestionOptionId(
                    commandOpen ? "skill-suggestions" : "agent-suggestions",
                    highlighted,
                  )
                : undefined
            }
            aria-autocomplete="list"
            onKeyDown={(event) => {
              // Escape closes the menu for the token as typed. It used to
              // clear the composer, which threw away a message someone had
              // already written just because they wanted the list gone.
              if (event.key === "Escape" && menuOpen) {
                event.preventDefault();
                setSuggestion((current) => ({
                  ...current,
                  token,
                  dismissed: true,
                }));
                return;
              }
              if (menuOpen && menuItems.length > 0 && isSuggestionKey(event.key)) {
                event.preventDefault();
                highlight(moveActive(highlighted, menuItems.length, event.key));
                return;
              }
              if (
                menuOpen &&
                menuItems.length > 0 &&
                (event.key === "Tab" ||
                  (event.key === "Enter" && !event.shiftKey))
              ) {
                event.preventDefault();
                chooseSuggestion(highlighted);
                return;
              }
              // Backspace into an empty composer takes the last skill back off,
              // matching how the chips read: they sit where a typed token was.
              if (
                event.key === "Backspace" &&
                !prompt &&
                pendingCommands.length > 0 &&
                !commandOpen
              ) {
                event.preventDefault();
                removeCommand(pendingCommands[pendingCommands.length - 1].name);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              pendingCommands.length === 1
                ? `Describe the outcome you need for ${pendingCommands[0].title}…`
                : pendingCommands.length > 1
                  ? `Describe the outcome you need for ${pendingCommands.length} skills…`
                  : commandsStatus === "unavailable"
                    ? "Describe the outcome you need…"
                    : requestedProfile || boundProfile
                      ? "Describe the outcome you need, or type / to load a skill…"
                      : "Describe the outcome you need, or type @ for an agent and / for a skill…"
            }
            rows={3}
          />
          <div className={styles.composerControls}>
            <input
              ref={fileInputRef}
              className={styles.fileInput}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              onChange={(event) => {
                void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              className={styles.attachButton}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach files"
              title="Attach files"
            >
              +
            </button>
            <VoiceInputButton
              contextId={activeId}
              disabled={!activeId || isRunning}
              onTranscript={(text, sessionId) => {
                if (sessionIsRunning(runs, sessionId)) {
                  pendingVoiceTurnsRef.current.push(
                    { id: crypto.randomUUID(), sessionId, text },
                  );
                  return;
                }
                void send(sessionId, text, "", EMPTY_SELECTION, true);
              }}
              onError={(message) => setError(message)}
            />
            <span className={styles.composerSpacer} />
            <select
              className={styles.effort}
              aria-label="Reasoning effort"
              title="Reasoning effort"
              value={reasoningEffort}
              onChange={(event) => setReasoningEffort(event.target.value)}
            >
              <option value="">Auto</option>
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>
                  {EFFORT_LABELS[effort]}
                </option>
              ))}
            </select>
            <button
              disabled={
                !prompt.trim() ||
                !activeId ||
                isRunning ||
                (mention !== null && !resolveMention(profiles, mention.query)) ||
                (command !== null && !resolveCommand(commands, command.query))
              }
              type="submit"
            >
              {mention
                ? "Choose agent"
                : command
                  ? "Load skill"
                  : isRunning
                    ? "Sending…"
                    : "Send"}
            </button>
          </div>
        </form>
      </section>

      {panelOpen && (
        <ArtifactWindow
          artifacts={artifacts}
          onClose={() => setPanelOpen(false)}
          width={panelWidth}
          getAvailableWidth={getDeliverablesAvailableWidth}
          onWidthChange={setPanelWidth}
        />
      )}
    </main>
  );
}
