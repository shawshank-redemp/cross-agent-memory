import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatOllama } from "@langchain/ollama";
import { StateGraph, MessagesAnnotation, START, END } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { StructuredToolInterface } from "@langchain/core/tools";

// think -> (call tool -> think)* -> answer. The model decides whether to call a
// tool; the graph routes to the tool node while the last message carries tool
// calls, and ends once the model answers in plain text.
export function buildAgent(model: ChatOllama, tools: StructuredToolInterface[]) {
  const bound = model.bindTools(tools);

  const think = async (state: typeof MessagesAnnotation.State) => {
    const reply = await bound.invoke(state.messages);
    return { messages: [reply] };
  };

  const route = (state: typeof MessagesAnnotation.State): "tools" | typeof END => {
    const last: BaseMessage | undefined = state.messages.at(-1);
    return last instanceof AIMessage && (last.tool_calls?.length ?? 0) > 0 ? "tools" : END;
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("think", think)
    .addNode("tools", new ToolNode(tools))
    .addEdge(START, "think")
    .addConditionalEdges("think", route, ["tools", END])
    .addEdge("tools", "think")
    .compile();
}
