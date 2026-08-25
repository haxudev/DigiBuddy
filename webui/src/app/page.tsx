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
import Markdown from "@/components/Markdown";
import SessionSidebar from "@/components/SessionSidebar";
import SignIn from "@/components/SignIn";
import SuggestionMenu, {
  suggestionOptionId,
  type SuggestionItem,
  type SuggestionStatus,
} from "@/components/SuggestionMenu";
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
  leadingCommand,
  matchCommands,
  resolveCommand,
  stripCommand,
  type SkillCommand,
} from "@/lib/skill-commands";
import { splitMessage } from "@/lib/ask-user";
import {
  deliveryFocus,
  shouldOpenDeliverables,
  type DeliveryFocus,
} from "@/lib/deliverables";
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

export default function Home() {
  const [selectedId, setSelectedId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState("");
  const [isRunning, setIsRunning] = useState(false);
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
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
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
  /** When the current turn was sent, so the wait can be counted honestly. */
  const [runStartedAt, setRunStartedAt] = useState(0);
  /**
   * The skill chosen for the next message.
   *
   * One message, not the conversation. A skill is markdown the model reads on
   * demand, so unlike the agent it can be chosen per turn -- and pretending
   * otherwise would either lie about the scope or force a new conversation for
   * every command.
   */
  const [pendingCommand, setPendingCommand] = useState<SkillCommand | null>(null);
  const [pendingTurn, setPendingTurn] = useState<{
    sessionId: string;
    text: string;
    profile: string;
  } | null>(null);
  // On phones and tablets the sidebar slides over the conversation instead of
  // squeezing it. The deliverable window is always an overlay.
  const [navOpen, setNavOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const agentRef = useRef<HttpAgent | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
  // another session's previous response id.
  useEffect(() => {
    if (!activeId) return;
    const session = getSession(activeId);
    if (!session) return;

    const agent = new HttpAgent({
      url: "/api/agent",
      threadId: session.threadId,
      initialMessages: session.messages.map((message) => ({ ...message })),
      initialState: { previousResponseId: session.previousResponseId },
    });
    agentRef.current = agent;

    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        // Thinking and tool rows arrive out of band so they never enter the
        // transcript the console stores and mines for deliverables.
        if (event.name !== ACTIVITY_EVENT_NAME) return;
        if (!isActivityEvent(event.value)) return;
        const activityEvent = event.value;
        setActivity((current) => reduceActivity(current, activityEvent));
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
        updateSession(activeId, (item) => ({
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
        updateSession(activeId, (item) => ({
          ...item,
          previousResponseId: responseId,
        }));
      },
    });

    return () => {
      agent.abortRun();
      subscription.unsubscribe();
      if (agentRef.current === agent) agentRef.current = null;
    };
  }, [activeId]);

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
  }, []);

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

  function chooseCommand(entry: SkillCommand) {
    setPendingCommand(entry);
    setPrompt(stripCommand(prompt));
  }

  const menuItems: SuggestionItem[] = useMemo(() => {
    if (commandOpen) {
      return commandMatches.map((entry) => ({
        key: entry.name,
        title: entry.title,
        description: entry.description || entry.hint,
        token: `/${entry.name}`,
        current: entry.name === pendingCommand?.name,
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
    pendingCommand,
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

  const send = useCallback(
    async (value: string, profileOverride = "", withCommand?: SkillCommand | null) => {
      const agent = agentRef.current;
      const text = value.trim();
      if (!text || isRunning) return;
      if (!agent) {
        setError("The conversation is still loading. Try sending again.");
        return;
      }

      setError("");
      setActivity([]);
      setRunStartedAt(Date.now());
      setIsRunning(true);
      agent.addMessage({ id: crypto.randomUUID(), role: "user", content: text });

      // Files belong to the turn that sends them, so the tray empties as soon
      // as the request is on its way.
      const files = attachments;
      setAttachments([]);
      // So does the skill. It was chosen for this message, and leaving it set
      // would silently apply it to the next one too.
      const chosen = withCommand === undefined ? pendingCommand : withCommand;
      setPendingCommand(null);

      try {
        await agent.runAgent({
          forwardedProps: {
            // A bound conversation keeps its agent whatever the picker shows,
            // because the runtime will keep it regardless.
            connection: {
              profile: profileOverride || boundProfile || requestedProfile,
            },
            attachments: files,
            reasoningEffort,
            skills: chosen?.skills ?? [],
            command: chosen?.name ?? "",
          },
        });
      } catch (runError) {
        setError(
          runError instanceof Error ? runError.message : "Agent request failed",
        );
      } finally {
        setActivity(settleActivity);
        setIsRunning(false);
      }
    },
    [
      attachments,
      boundProfile,
      isRunning,
      pendingCommand,
      reasoningEffort,
      requestedProfile,
    ],
  );

  useEffect(() => {
    if (
      !pendingTurn ||
      pendingTurn.sessionId !== activeId ||
      !agentRef.current ||
      isRunning
    ) {
      return;
    }
    setPendingTurn(null);
    void send(pendingTurn.text, pendingTurn.profile);
  }, [activeId, isRunning, pendingTurn, send]);

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
      setError("");
      setPrompt("");
      void send(invoked.message, "", resolved);
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
      void send(addressed.message, resolved.name);
      return;
    }
    if (!activeId || !agentRef.current) {
      setError("The conversation is still loading. Try sending again.");
      return;
    }
    const value = prompt;
    setPrompt("");
    void send(value);
  }

  function selectSession(sessionId: string) {
    setSelectedId(sessionId);
    setError("");
    setNavOpen(false);
    setPanelOpen(false);
    // Activity describes one run, so it never follows the reader to another
    // session.
    setActivity([]);
    setRunStartedAt(0);
    // Neither does an armed skill. Each conversation runs its own agent, and a
    // skill that agent cannot reach would be dropped by the runtime — leaving a
    // chip that promises something the next message would not do.
    setPendingCommand(null);
  }

  function createNewSession(withProfile = ""): string {
    const session = createSession(withProfile);
    replaceSessions(upsertSession(sessions, session));
    selectSession(session.id);
    return session.id;
  }

  function deleteSession(sessionId: string) {
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
    <main className={styles.shell} data-nav={navOpen ? "open" : "closed"}>
      <div className={styles.navSlot}>
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
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
        onClick={() => setNavOpen(false)}
      />

      <section className={styles.chat}>
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
            {artifacts.length > 0 && (
              <button
                type="button"
                className={styles.deliverablesButton}
                onClick={() => setPanelOpen(true)}
                aria-label="Show deliverables"
              >
                ▤ {artifacts.length}
              </button>
            )}
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
                  <small>You</small>
                  <p>{message.content}</p>
                </article>
              ) : (
                <article className={styles.agentMessage} key={message.id}>
                  <small>GTMBuddy</small>
                  {splitMessage(
                    stripProfileMetadata(stripArtifactMetadata(message.content)),
                    message.id,
                  ).map((segment, index) =>
                    segment.kind === "ask" ? (
                      <AskUserCard
                        key={segment.request.id}
                        request={segment.request}
                        disabled={isRunning}
                        onAnswer={(answer) => void send(answer)}
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
          {pendingCommand && (
            <ul className={styles.attachments}>
              <li>
                <span>
                  /{pendingCommand.name}
                  {pendingCommand.hint ? ` — ${pendingCommand.hint}` : ""}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${pendingCommand.title}`}
                  onClick={() => setPendingCommand(null)}
                >
                  ×
                </button>
              </li>
            </ul>
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
              // Backspace into an empty composer takes the skill back off,
              // matching how the chip reads: it sits where a typed token was.
              if (
                event.key === "Backspace" &&
                !prompt &&
                pendingCommand &&
                !commandOpen
              ) {
                event.preventDefault();
                setPendingCommand(null);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={
              pendingCommand
                ? `Describe the outcome you need for ${pendingCommand.title}…`
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

      {panelOpen && artifacts.length > 0 && (
        <ArtifactWindow artifacts={artifacts} onClose={() => setPanelOpen(false)} />
      )}
    </main>
  );
}
