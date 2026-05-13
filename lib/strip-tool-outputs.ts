import { isToolUIPart, type UIMessage } from 'ai';

// Replace tool outputs on every assistant message except the most recent.
// Tool results (searchCorpus chunks, dossier turns, fetched articles) can be
// 50–200 KB each; with no cache breakpoint past the system block, those
// outputs get billed at full input rate on every follow-up turn. The model's
// text response already contains its synthesis of those outputs, and it can
// re-call the tool if it needs the raw data again. The most recent assistant
// is left intact so the model can still reference its just-completed tool
// results. Persistence is unaffected — only the in-memory copy sent to
// `convertToModelMessages` is stripped.
const STRIPPED_TOOL_OUTPUT = {
  note: 'Output omitted from history. Call the tool again if you need the full result.',
};

const STRIPPED_ERROR_TEXT =
  'Error message omitted from history. Re-run the tool to reproduce the error if needed.';

export function stripStaleToolOutputs(messages: UIMessage[]): UIMessage[] {
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx <= 0) return messages;
  return messages.map((m, i) => {
    if (m.role !== 'assistant' || i === lastAssistantIdx) return m;
    if (!Array.isArray(m.parts)) return m;
    let changed = false;
    const newParts = m.parts.map((part) => {
      if (!isToolUIPart(part)) return part;
      // Provider-executed tools serialize the result back into the assistant
      // content block where the provider may re-validate it; leave those
      // alone since none of the current tools use this path.
      if (part.providerExecuted) return part;
      if (part.state === 'output-available') {
        changed = true;
        return { ...part, output: STRIPPED_TOOL_OUTPUT };
      }
      if (part.state === 'output-error') {
        changed = true;
        return { ...part, errorText: STRIPPED_ERROR_TEXT };
      }
      return part;
    });
    return changed ? { ...m, parts: newParts as UIMessage['parts'] } : m;
  });
}
