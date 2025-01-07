import OpenAI from "openai";
import Tool from "./core/Tool";
import Conversation from "./core/Conversation";
import Thought from "./core/Thought";
import Environment from "./core/Environment";
import type { MessageContent } from "./core/ChatMessage";
import ChatMessage from "./core/ChatMessage";
import ModelService from "./services/ModelService";
import ReflectionService from "./services/ReflectionService";
import ConversationRepository from "@src/shared/agents/ConversationRepository";
import Agent from "./core/Agent";
import Interaction from "./core/Interaction";

interface ThoughtAgentProps {
  language: string;
  conversation: Conversation;
  enableMultimodal: boolean;
  enableReflection: boolean;
  modelService: ModelService;
  reflectionService?: ReflectionService;
}

class ThoughtAgent implements Agent {
  language: string;
  protected readonly enableMultimodal: boolean;
  protected readonly enableReflection: boolean;
  private readonly tools: Tool[] = [];
  private readonly name: string;
  private readonly description: string;
  private readonly conversation: Conversation;
  private readonly modelService: ModelService;
  private readonly reflectionService: ReflectionService;
  private receiveStreamMessageListener: (msg: string) => void;
  private repo: ConversationRepository;

  constructor(
    props: ThoughtAgentProps,
    name: string = "Guru",
    description: string = "Guru",
  ) {
    this.language = props.language;
    this.conversation = props.conversation;
    this.modelService = props.modelService;
    this.reflectionService = props.reflectionService;
    this.enableMultimodal = props.enableMultimodal;
    this.enableReflection = props.enableReflection;
    this.name = name;
    this.description = description;
  }

  /**
   * On start interaction:
   *  1. append user message
   *  2. perception environment
   *
   * There are two ways to call this method:
   *  1. When calling the chat method
   *  2. When calling the executeCommand method
   * @returns {void}
   */
  private async onStartInteraction(message: ChatMessage): Promise<void> {
    this.getConversation().appendMessage(message);
    const interaction = this.getCurrentInteraction();
    // Perception
    interaction.environment = await this.environment();
  }

  /**
   * Get current environment
   */
  protected getCurrentEnvironment(): Environment {
    return this.getCurrentInteraction().environment;
  }

  protected getCurrentInteraction(): Interaction {
    return this.getConversation().getCurrentInteraction();
  }

  /**
   * When the chat (or executeCommand) is completed, then do the following:
   * 1. Get the message from the thought
   * 2. Append the message to the conversation, and then save the conversation
   * 3. Review the conversation, reflect, and then execute the actions
   * @param result
   */
  private async onCompleted(result: Thought): Promise<string> {
    if (result.type === "error") {
      this.getCurrentInteraction().setStatus("Completed", "");
      return result.error.message;
    }

    let message = await result.getMessage((msg) => {
      this.notifyMessageChanged(msg);
    });

    this.getConversation().appendMessage(
      new ChatMessage({
        role: "assistant",
        content: message,
        name: this.getName(),
      }),
    );
    await this.record();

    let thought = await this.reflection();
    while (thought && thought.type === "actions") {
      await this.execute(thought.actions);
      thought = await this.reflection();
    }
    if (thought && ["stream", "message"].includes(thought.type)) {
      this.notifyMessageChanged("");
      message = await thought.getMessage((msg) => {
        this.notifyMessageChanged(msg);
      });
    }

    this.getCurrentInteraction().setStatus("Completed", "");
    return message;
  }

  protected notifyMessageChanged(message: string) {
    if (this.receiveStreamMessageListener) {
      this.receiveStreamMessageListener(message);
    }
  }

  onMessageChange(listener: (msg: string) => void): Agent {
    this.receiveStreamMessageListener = listener;
    return this;
  }

  private async record(): Promise<string> {
    if (this.repo) {
      return await this.repo.save(this.getConversation());
    }

    return null;
  }

  public setConversationRepository(
    conversationRepository: ConversationRepository,
  ) {
    this.repo = conversationRepository;
  }

  getName(): string {
    return this.name;
  }

  getDescription(): string {
    return this.description;
  }

  /**
   * Implement interface method, return tools that the agent can use
   * @returns {Tool[]} Tools
   */
  getTools(): Tool[] {
    return this.tools;
  }

  /**
   * Get conversation
   * @returns {Conversation} Conversation
   */
  getConversation(): Conversation {
    return this.conversation;
  }

  /**
   * Add tool
   * 1. Create a new tool with given name and description
   * 2. Add string parameters to the tool
   * 3. Set user input as argument, so agent can understand that user input could be which parameter
   *    - If there are more than one string parameters, and user input as argument is not given, set the first one as user input as argument
   *    - If user input as argument is given, set it as user input as argument
   *    eg. when user types "/ask_page xxx", agent should understand the user input (xxx) is the parameter "question"
   * 4. At last add tool to the tools
   * @param {string} name - Name of the tool
   * @param {string} description - Description of the tool
   * @param {string[]} stringParameters - String parameters
   * @returns {void}
   */
  addTool(name: string, description: string, stringParameters: string[]): Tool {
    const tool = new Tool(name, description);
    for (const stringParameter of stringParameters) {
      tool.setStringParameter(stringParameter);
    }

    this.getTools().push(tool);
    return tool;
  }

  /**
   * Get tool calls
   * @returns {OpenAI.Chat.Completions.ChatCompletionTool[]} ChatCompletionTools
   */
  getToolCalls(): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return this.getTools().map((tool) => tool.getFunction());
  }

  /**
   * Choose the tool agent to execute the tool
   * @param {ChatMessage} message - Chat message
   * @returns {Promise<Thought>} ChatCompletion
   * @async
   */
  async chat(message: ChatMessage): Promise<Thought> {
    await this.onStartInteraction(message);
    const thought = await this.plan();
    const result = await this.process(thought);
    const output = await this.onCompleted(result);
    return new Thought({ type: "message", message: output });
  }

  private async process(thought: Thought): Promise<Thought> {
    if (thought.type === "actions") {
      return await this.execute(thought.actions);
    } else if (["message", "stream"].includes(thought.type)) {
      return await this.execute([this.replyAction(thought)]);
    } else if (thought.type === "error") {
      return thought;
    }

    throw new Error("Unknown plan type");
  }

  /**
   * Execute
   * @param {Action[]} actions - Actions
   * @param {Conversation} conversation - Conversation
   * @returns {Promise<Thought>} ChatCompletion
   */
  async executeCommand(
    actions: Action[],
    message: ChatMessage,
  ): Promise<Thought> {
    await this.onStartInteraction(message);
    const result = await this.execute(actions);
    const output = await this.onCompleted(result);
    return new Thought({ type: "message", message: output });
  }

  /**
   * Describe the current environment
   * @returns {Environment} Environment description
   */
  async environment(): Promise<Environment> {
    return new Promise<Environment>((resolve, reject) => {
      resolve({ systemPrompt: () => "" });
    });
  }

  /**
   * Think
   * @returns {Promise<Thought>} ThinkResult
   */
  async plan(): Promise<Thought> {
    const interaction = this.conversation.getCurrentInteraction();
    interaction.setStatus("Planning", `${this.getName()} is thinking...`);
    if (this.enableReflection && this.reflectionService) {
      interaction.setGoal(
        await this.reflectionService.goal(
          this.getCurrentEnvironment(),
          this.getConversation(),
        ),
      );
    }

    const env = this.getCurrentEnvironment();
    const systemMessage = new ChatMessage({
      role: "system",
      content: env.systemPrompt(),
    });
    const messages = this.conversation.getMessages();
    const messagesWithEnv = env.systemPrompt()
      ? [systemMessage, ...messages.slice(1)]
      : messages;

    const toolCalls = this.getToolCalls();
    if (toolCalls.length === 0) {
      return new Thought({ type: "actions", actions: [] });
    }
    return await this.toolsCall(messagesWithEnv, toolCalls, true);
  }

  /**
   * Reflection
   * @returns {Promise<Thought | null>} Actions
   */
  async reflection(): Promise<Thought | null> {
    if (!this.enableReflection) {
      return null;
    }

    const interaction = this.conversation.getCurrentInteraction();
    interaction.setStatus("Reflecting", `${this.getName()} is reflecting...`);
    this.getCurrentInteraction().environment = await this.environment();

    return await this.reflectionService.reflection(
      this.getCurrentEnvironment(),
      this.conversation,
      this.getTools(),
    );
  }

  /**
   * Tracking dialogue state, should be invoked in execute method, before actions are executed
   * @param {Action[]} actions - Actions
   * @returns {Action[]} Actions
   */
  trackingDialogueState(actions: Action[]): Action[] {
    const messages = this.conversation.getMessages();
    const interaction = this.conversation.getCurrentInteraction();
    // TODO: Implement tracking dialogue state
    if (actions.length === 0) {
      return [this.chatAction(messages[messages.length - 1].content)];
    }
    // TODO: The connections between intent and actions are missing.
    interaction.setIntent(actions[0].name, actions[0].arguments);
    return actions;
  }

  /**
   * Execute
   * @param {Action[]} actions - Actions
   * @returns {Promise<Thought>} ChatCompletion
   */
  async execute(actions: Action[]): Promise<Thought> {
    const refinedActions = this.trackingDialogueState(actions);

    const interaction = this.conversation.getCurrentInteraction();
    const actionNameList = refinedActions.map((a) => a.name);
    interaction.setStatus(
      "Executing",
      `${this.getName()} is executing ${actionNameList.join(", ")}...`,
    );
    interaction.setAgentName(this.getName());

    // TODO: support multiple actions in future
    const action = refinedActions[0].name;
    const args = refinedActions[0].arguments;

    if (action === "chat") {
      const env = await this.environment();
      return this.chatCompletion(
        this.conversation.getMessages(),
        env.systemPrompt(),
        args["userInput"],
      );
    }

    if (action === "reply") {
      return args["thought"] as Thought;
    }

    for (const member of this.getMemberOfSelf()) {
      if (member === action && typeof this[member] === "function") {
        // TODO: need to verify if arguments of function are correct
        return this[member].apply(this, [
          args,
          this.conversation.getMessages(),
        ]);
      }
    }

    // If could not find the action by function name,
    // then agent should implement executeAction method.
    return this.executeAction(action, args, this.conversation);
  }

  private getMemberOfSelf(): string[] {
    return Object.getOwnPropertyNames(Object.getPrototypeOf(this));
  }

  /**
   * Execute command
   * @param {string} action - Action
   * @param {object} args - Pojo object as Arguments
   * @param {Conversation} conversation - Conversation
   * @returns {Promise<Thought>} ChatCompletion
   */
  async executeAction(
    action: string,
    args: object,
    conversation: Conversation,
  ): Promise<Thought> {
    throw new Error("Unimplemented action: " + action);
  }

  private replyAction(thought: Thought): Action {
    return { name: "reply", arguments: { thought: thought } } as Action;
  }

  private chatAction(userInput: string | MessageContent[]): Action {
    return { name: "chat", arguments: { userInput: userInput } } as Action;
  }

  /**
   * Chat completion
   * @param {ChatMessage[]} messages - Messages
   * @param {string} systemPrompt - System prompt
   * @param {string} replaceUserInput - Replace user input
   * @param {bool} stream - Stream
   * @returns {Promise<Thought>} ThinkResult
   */
  async chatCompletion(
    messages: ChatMessage[],
    systemPrompt: string = "",
    replaceUserInput: string | MessageContent[] = "",
    stream: boolean = true,
    responseType: "text" | "json_object" = "text",
  ): Promise<Thought> {
    if (systemPrompt && messages.length > 0 && messages[0].role === "system") {
      const systemMessage = new ChatMessage({
        role: "system",
        content: systemPrompt,
      });
      messages = [systemMessage, ...messages.slice(1)];
    }

    if (
      replaceUserInput &&
      messages.length > 1 &&
      messages[messages.length - 1].role === "user"
    ) {
      const userMessage = new ChatMessage({
        role: "user",
        content: replaceUserInput,
      });
      messages = [...messages.slice(0, messages.length - 1), userMessage];
    }

    return await this.modelService.chatCompletion(
      messages,
      stream,
      this.enableMultimodal,
      responseType,
    );
  }

  /**
   * Tools call
   * @param {ChatMessage[]} messages - Messages
   * @param {OpenAI.Chat.Completions.ChatCompletionTool[]} tools - Tools
   * @param {bool} stream - Stream
   * @returns {Promise<any>}
   */
  async toolsCall(
    messages: ChatMessage[],
    tools: OpenAI.Chat.Completions.ChatCompletionTool[],
    stream: boolean = false,
    responseType: "text" | "json_object" = "text",
  ): Promise<Thought> {
    return await this.modelService.toolsCall(
      messages,
      tools,
      stream,
      responseType,
    );
  }
}

export default ThoughtAgent;
export type { ThoughtAgentProps };
