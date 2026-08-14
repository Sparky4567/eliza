# Build an Incrementally Learning ELIZA-Style CLI LLM Bot in Python

## Mission

Build a modular Python CLI conversational bot inspired by the original ELIZA, but extended into a modern hybrid system that can:

- Have natural conversations through a terminal CLI.
- Use deterministic ELIZA-style rules for predictable behavior.
- Use a local LLM such as Ollama when rules are insufficient.
- Maintain a persistent knowledge base.
- Remember useful information from previous conversations.
- Retrieve relevant memories and knowledge during future conversations.
- Learn incrementally from conversations.
- Detect and store new facts, concepts, preferences, corrections, and successful responses.
- Improve its response strategies over time without requiring model retraining.
- Evaluate whether newly learned information is useful before permanently accepting it.
- Remain completely inspectable and editable by the developer.
- Work offline when the local LLM is available.
- Keep the architecture simple enough that every component can be understood and modified.

The goal is **not** to train a new language model.

The goal is to create a persistent cognitive layer around an existing LLM.

The resulting architecture should resemble:

```text
                         ┌────────────────────┐
                         │      CLI User      │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │ Conversation Loop  │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │ Context Builder    │
                         └─────────┬──────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
                ▼                  ▼                  ▼
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │   Memories   │   │  Knowledge   │   │ ELIZA Rules  │
        │    Store     │   │     Base     │   │ / Patterns   │
        └──────────────┘   └──────────────┘   └──────────────┘
                │                  │                  │
                └──────────────────┼──────────────────┘
                                   ▼
                         ┌────────────────────┐
                         │    Local LLM       │
                         │      Ollama        │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │ Response Evaluator │
                         └─────────┬──────────┘
                                   │
                    ┌──────────────┼──────────────┐
                    ▼              ▼              ▼
                Response       New Memory      New Knowledge
```

---

## 1. Technology Requirements

Use Python 3.12+.

Prefer a minimal dependency set.

Recommended components:

- Python
- `ollama` Python package or direct HTTP communication with Ollama
- SQLite for persistent structured data
- JSON/YAML for human-editable configuration and rules
- Python standard library wherever practical

Do not introduce a large agent framework unless there is a concrete reason.

The system should remain understandable without LangChain, LlamaIndex, or another abstraction layer.

The initial implementation should run with:

```bash
python main.py
```

and provide an interactive terminal conversation.

---

# 2. Core Design Principle

Separate these concepts:

### Model

The LLM generates language.

### Memory

Memory stores information about previous interactions.

### Knowledge

Knowledge stores facts, concepts, relationships, and learned information.

### Rules

Rules define deterministic conversational behavior.

### Learning

Learning extracts potentially useful information from conversations.

### Evaluation

Evaluation determines whether information or behavior should be retained.

Never allow the LLM to directly rewrite the entire knowledge base.

All persistent changes must pass through controlled Python code.

The LLM proposes changes.

The application validates and commits them.

---

# 3. Project Structure

Create the project approximately like this:

```text
eliza_ai/
│
├── main.py
│
├── config.py
│
├── bot/
│   ├── __init__.py
│   ├── conversation.py
│   ├── context.py
│   ├── response.py
│   └── evaluator.py
│
├── eliza/
│   ├── __init__.py
│   ├── patterns.py
│   ├── matcher.py
│   └── reflection.py
│
├── memory/
│   ├── __init__.py
│   ├── store.py
│   ├── retrieval.py
│   └── models.py
│
├── knowledge/
│   ├── __init__.py
│   ├── store.py
│   ├── retrieval.py
│   ├── learning.py
│   └── models.py
│
├── llm/
│   ├── __init__.py
│   ├── ollama.py
│   └── prompts.py
│
├── data/
│   ├── bot.db
│   ├── rules.json
│   └── knowledge/
│
└── tests/
    ├── test_eliza.py
    ├── test_memory.py
    ├── test_knowledge.py
    └── test_learning.py
```

Do not create all modules at once.

Implement the system incrementally.

---

# 4. Phase One: Basic CLI

First create a functioning conversation loop.

Requirements:

```text
You: hello
Bot: Hello. Tell me more.

You: I am experimenting with Python.
Bot: What are you experimenting with?

You: /quit
Bot: Goodbye.
```

Support commands:

```text
/help
/quit
/exit
/clear
/memory
/knowledge
/stats
/reload
```

The normal conversation should not require slash commands.

---

# 5. Phase Two: Classic ELIZA Engine

Implement a deterministic pattern engine before connecting the LLM.

Represent patterns as data rather than hard-coding them into Python.

Example:

```json
{
  "patterns": [
    {
      "keywords": ["mother"],
      "responses": [
        "Tell me more about your mother.",
        "How do you feel about your mother?"
      ],
      "priority": 10
    },
    {
      "keywords": ["feel"],
      "responses": [
        "Tell me more about those feelings.",
        "Why do you feel that way?"
      ],
      "priority": 5
    }
  ]
}
```

The matcher should:

1. Normalize the input.
2. Tokenize it.
3. Detect matching keywords.
4. Rank matching patterns.
5. Select the highest-priority pattern.
6. Generate a response.
7. Fall back to the LLM if appropriate.

Implement pronoun reflection:

```text
I      → you
me     → you
my     → your
mine   → yours
you    → I
your   → my
```

Keep this engine independent of the LLM.

---

# 6. Phase Three: Ollama Integration

Create a dedicated `OllamaClient`.

Do not scatter Ollama API calls throughout the project.

Example interface:

```python
class OllamaClient:

    async def generate(
        self,
        messages: list[dict],
        model: str
    ) -> str:
        ...
```

Support streaming responses.

The CLI should display generated tokens as they arrive.

The LLM should receive a carefully constructed context:

```text
SYSTEM
Bot identity and behavioral rules

MEMORIES
Relevant persistent memories

KNOWLEDGE
Relevant knowledge retrieved from the knowledge base

CONVERSATION
Recent conversation history

USER
Current user message
```

Do not dump the entire database into the prompt.

Retrieve only relevant information.

---

# 7. Phase Four: Persistent Conversation Memory

Implement SQLite-backed memory.

Each conversation message should contain at least:

```text
id
session_id
timestamp
role
content
```

Store:

```text
user messages
assistant messages
```

Do not treat every message as a permanent memory.

Conversation history and long-term memory are different things.

---

# 8. Long-Term Memory

Create a memory table containing concepts such as:

```text
id
type
content
source
confidence
importance
created_at
updated_at
last_used_at
usage_count
```

Memory types may include:

```text
fact
preference
goal
project
concept
relationship
instruction
correction
observation
```

Example:

```text
type: project
content: User is building a Python CLI chatbot.
confidence: 0.95
importance: 0.8
```

The bot should retrieve memories based on relevance.

Do not automatically save every statement.

---

# 9. Memory Extraction

After a conversation turn, run a separate extraction process.

The LLM should receive something like:

```text
Analyze the conversation.

Identify information that may be useful in future conversations.

Return ONLY structured JSON.

Possible categories:

- fact
- preference
- goal
- project
- concept
- correction
- instruction

Do not infer sensitive personal information.
Do not invent facts.
Only extract information explicitly supported by the conversation.
```

Expected result:

```json
{
  "memories": [
    {
      "type": "project",
      "content": "The user is building a Python CLI chatbot.",
      "confidence": 0.95,
      "importance": 0.8
    }
  ]
}
```

Validate the JSON before storing it.

---

# 10. Memory Consolidation

Do not simply append memories forever.

Implement consolidation.

For example:

```text
"I use Python"

"I am building a Python chatbot"

"I prefer Python for small CLI projects"
```

These may eventually become related memories.

The system should be able to detect:

```text
duplicate
similar
contradictory
obsolete
more-specific
```

When a new memory conflicts with an old memory:

```text
Old:
User prefers JavaScript.

New:
User now prefers Python.
```

Do not silently delete the old information.

Record the relationship:

```text
old_memory → superseded_by → new_memory
```

This creates a history of learning.

---

# 11. Knowledge Base

Build a separate knowledge system.

Memory describes the user and previous interactions.

Knowledge describes concepts the bot has learned.

Example:

```text
Concept:
Python

Definition:
A high-level programming language.

Related:
CLI
OOP
asyncio
SQLite
Ollama
```

Store knowledge entries with:

```text
id
title
content
category
source
confidence
created_at
updated_at
```

Possible categories:

```text
programming
science
history
technology
projects
concept
procedure
definition
```

---

# 12. Knowledge Acquisition

The bot should be capable of learning from:

1. User explanations.
2. Explicit corrections.
3. Local documents.
4. Conversation discoveries.
5. Existing knowledge.
6. Optional external sources.

The system must distinguish:

```text
User-provided information
Model-generated information
Externally sourced information
Derived information
```

Never present model-generated guesses as established knowledge.

Each knowledge item should contain provenance.

Example:

```text
source_type: user
source_reference: conversation:2026-08-14-001
confidence: 0.95
```

---

# 13. Incremental Learning

The bot should improve without modifying its underlying LLM weights.

Use:

```text
better memory
better retrieval
better rules
better prompts
better examples
better evaluations
better knowledge
```

instead of model retraining.

The learning loop should be:

```text
Conversation
     ↓
Observation
     ↓
Candidate knowledge/memory
     ↓
Validation
     ↓
Evaluation
     ↓
Storage
     ↓
Future retrieval
     ↓
Better response
     ↓
Evaluation
     ↓
Improved strategy
```

---

# 14. Response Evaluation

After generating a response, optionally evaluate it.

The evaluator should consider:

```text
relevance
factual consistency
usefulness
context awareness
repetition
memory usage
hallucination risk
```

Return structured data such as:

```json
{
  "score": 0.82,
  "relevant": true,
  "used_memory": true,
  "potential_hallucination": false,
  "notes": "Response correctly used the user's project context."
}
```

Do not let the evaluator blindly rewrite the response.

Its primary purpose is to generate learning signals.

---

# 15. Learning From Corrections

Explicit corrections should have high priority.

Example:

```text
User:
No, I meant SQLite, not PostgreSQL.
```

The system should recognize this as a correction.

Store:

```text
correction:
PostgreSQL → SQLite
```

Future retrieval should prefer the corrected information.

This is one of the simplest and most valuable forms of incremental learning.

---

# 16. Learning From Successful Patterns

Track response strategies.

For example:

```text
strategy: ask_followup
success_score: 0.78

strategy: explain_directly
success_score: 0.91

strategy: use_eliza_pattern
success_score: 0.64
```

Over time, the system can learn which strategy works best for different types of conversations.

Do not use uncontrolled self-modifying Python code.

Instead, store strategy statistics in the database.

---

# 17. Retrieval

Implement simple retrieval first.

Start with:

```text
keyword matching
```

Then add:

```text
TF-IDF
```

Then optionally add:

```text
embeddings
vector search
```

Do not start with a vector database just because everyone on the internet seems contractually obligated to recommend one.

SQLite plus a sensible retrieval layer is enough for the initial system.

The retrieval API should remain abstract:

```python
class Retriever:

    def search(
        self,
        query: str,
        limit: int = 5
    ):
        ...
```

This makes it possible to replace the retrieval implementation later.

---

# 18. Context Construction

Create a dedicated context builder.

Example:

```python
context = context_builder.build(
    user_message=user_input,
    conversation=recent_messages,
    memories=relevant_memories,
    knowledge=relevant_knowledge
)
```

The context builder should:

1. Retrieve relevant memories.
2. Retrieve relevant knowledge.
3. Include recent conversation.
4. Remove duplicates.
5. Rank information.
6. Apply token limits.
7. Construct the final LLM prompt.

Never exceed the model's context window.

---

# 19. Hybrid Response Strategy

The bot should decide whether to use:

```text
ELIZA rule
LLM
ELIZA + LLM
```

Example:

```text
Simple emotional statement
        ↓
ELIZA pattern
        ↓
Deterministic response
```

Complex question:

```text
User asks about Python architecture
        ↓
Retrieve knowledge
        ↓
Ollama
        ↓
Contextual response
```

A useful hybrid approach is:

```text
ELIZA
  ↓
detect conversational intent
  ↓
memory/knowledge retrieval
  ↓
LLM response
```

The ELIZA layer becomes the bot's conversational skeleton rather than merely a collection of canned responses.

---

# 20. Self-Improvement Without Self-Modification

The bot must not arbitrarily modify its own source code.

Instead, allow it to improve through controlled artifacts:

```text
data/rules.json
data/knowledge/*
data/bot.db
config/*
evaluation statistics
prompt templates
```

A future improvement cycle can be:

```text
Observe
→ Evaluate
→ Propose
→ Validate
→ Store
→ Test
→ Activate
```

Any generated rule should initially be marked:

```text
status: candidate
```

Only activate it after validation.

Use:

```text
candidate
approved
rejected
deprecated
```

as rule states.

---

# 21. Version the Knowledge Base

Every knowledge change should be traceable.

Store:

```text
version
previous_version
change_reason
source
timestamp
```

The system should be able to answer:

```text
Why does the bot believe this?

Where did it learn this?

When did it learn this?

What information replaced the previous belief?
```

This is essential for debugging.

---

# 22. Human Override

Implement commands:

```text
/remember <text>
/forget <id>
/knowledge <query>
/memory <query>
/correct <text>
/teach <text>
```

Examples:

```text
/remember The project uses SQLite.
/teach Python asyncio allows asynchronous programming.
/correct The project uses Bun, not Node.
```

Explicit user-provided corrections should have high confidence.

The user must remain able to inspect and delete stored information.

---

# 23. CLI Diagnostics

Implement:

```text
/stats
```

which might display:

```text
Sessions:       42
Messages:       1,284
Memories:       87
Knowledge:      143
Corrections:    12
Rules:          31
Candidates:     6
```

Implement:

```text
/memory
```

to inspect recent memories.

Implement:

```text
/knowledge Python
```

to inspect relevant knowledge.

Implement:

```text
/trace
```

to show how the current response was constructed:

```text
Input:
    How should I structure this Python project?

Matched rules:
    programming

Retrieved memories:
    project: Python CLI chatbot

Retrieved knowledge:
    Python project architecture

Response strategy:
    LLM

Model:
    gemma3

Evaluation:
    0.87
```

This observability is extremely important.

A learning system that cannot explain why it produced something becomes a debugging séance.

---

# 24. Testing

Write tests before making the learning system complicated.

Test:

```text
keyword matching
pattern priority
pronoun reflection
memory creation
memory retrieval
duplicate detection
contradiction detection
knowledge retrieval
correction handling
JSON validation
LLM failures
database failures
empty input
long input
```

Add integration tests for:

```text
conversation → extraction → storage → retrieval → response
```

---

# 25. Failure Handling

The bot must continue working if Ollama is unavailable.

Fallback behavior:

```text
Ollama available
    ↓
Use LLM

Ollama unavailable
    ↓
Use ELIZA rules

No matching ELIZA rule
    ↓
Use generic fallback
```

Never crash the entire CLI because the model server disappeared.

---

# 26. Privacy and Data Safety

Keep persistent data local by default.

Do not collect sensitive personal information unnecessarily.

Do not automatically store everything the user says.

Provide a way to inspect and delete memories.

Never fabricate memories.

Never claim that the bot remembers something unless it actually exists in persistent storage.

---

# 27. Development Order

Implement the project in this exact order:

### Stage 1

CLI conversation loop.

### Stage 2

ELIZA keyword and pattern engine.

### Stage 3

Pronoun reflection.

### Stage 4

Ollama integration.

### Stage 5

Conversation history.

### Stage 6

SQLite memory store.

### Stage 7

Memory extraction.

### Stage 8

Memory retrieval.

### Stage 9

Knowledge base.

### Stage 10

Knowledge extraction.

### Stage 11

Correction and contradiction handling.

### Stage 12

Response evaluation.

### Stage 13

Strategy statistics.

### Stage 14

Candidate rule generation.

### Stage 15

Knowledge/version history.

### Stage 16

Diagnostics and `/trace`.

### Stage 17

Tests and reliability improvements.

Do not implement later stages before the earlier stages work.

---

# 28. Important Architectural Rule

Do not make the LLM the entire application.

The architecture should be:

```text
Python application
       │
       ├── conversation
       ├── rules
       ├── memory
       ├── knowledge
       ├── retrieval
       ├── evaluation
       └── learning
                │
                ▼
              Ollama
```

not:

```text
Python
  ↓
send everything to LLM
  ↓
hope for intelligence
```

The first architecture gives you an actual system.

The second gives you a prompt wrapped in Python.

---

# 29. Definition of "Learning"

For this project, learning means:

> The system becomes more useful in future conversations because information, corrections, successful strategies, and knowledge discovered in previous interactions become available to future responses.

Learning does **not** initially mean:

```text
gradient descent
fine-tuning
LoRA
weight modification
training a neural network
```

Those can be explored later if useful.

First build a strong persistent cognitive layer.

---

# 30. Final Acceptance Test

The finished prototype should support a conversation like:

```text
You: I'm building a Python chatbot.

Bot: What kind of chatbot are you building?

You: A CLI bot inspired by ELIZA.

Bot: That sounds interesting. What do you want it to learn?

You: I want it to remember concepts and improve over time.

Bot: How should it store that knowledge?

You: SQLite for structured memory.

Bot: I'll keep that in mind.
```

Later, after restarting the application:

```text
You: What was I working on?

Bot: You were building a Python CLI chatbot inspired by ELIZA,
using SQLite for persistent memory and knowledge.
```

Then:

```text
You: Actually, I changed it. I'm using PostgreSQL now.

Bot: Got it. The project database has changed from SQLite to PostgreSQL.
```

After another restart:

```text
You: What database is the project using?

Bot: PostgreSQL.
```

The system should be able to show why:

```text
/trace

Memory:
    Project database = PostgreSQL

Previous:
    SQLite

Status:
    superseded

Source:
    explicit user correction

Confidence:
    0.99
```

That is the core demonstration that the system is **incrementally learning rather than merely generating text**.

---

# 31. Coding-LLM Instructions

When implementing this project:

1. Work incrementally.
2. Do not rewrite the entire project when fixing one component.
3. Preserve working functionality.
4. Keep modules small.
5. Prefer explicit Python code over clever abstractions.
6. Add tests alongside new functionality.
7. Never silently discard persistent data.
8. Use migrations when changing the database schema.
9. Validate all LLM-generated structured data.
10. Treat LLM output as untrusted input.
11. Keep the LLM client replaceable.
12. Keep retrieval replaceable.
13. Keep memory and knowledge separate.
14. Keep conversation history separate from long-term memory.
15. Make every learning operation observable.
16. Never allow automatic source-code self-modification.
17. Prefer reversible changes.
18. Log important learning events.
19. Keep the system usable without an LLM whenever possible.
20. Do not add dependencies unless they solve an actual problem.

At every stage, provide:

```text
1. What was implemented.
2. Which files changed.
3. Why the change was made.
4. How to run it.
5. How to test it.
6. What remains to implement.
```

The final result should be a small, understandable, persistent Python conversational agent whose capabilities grow primarily through **memory, knowledge acquisition, retrieval, evaluation, and controlled learning**, rather than through continually increasing model complexity.