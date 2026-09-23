# llama.cpp GBNF. The model may emit one tool call and nothing else.
# browser_login is intentionally absent: the planner must not invent passwords.
TOOL_GRAMMAR = r'''
root ::= "{" ws "\"tool\"" ws ":" ws toolname ws "," ws "\"args\"" ws ":" ws object ws "}"
toolname ::= "\"browser_goto\"" | "\"browser_read\"" | "\"browser_click\"" | "\"browser_type\"" | "\"browser_submit\"" | "\"done\""
object ::= "{" ws "}" | "{" ws members ws "}"
members ::= pair (ws "," ws pair)*
pair ::= string ws ":" ws string
string ::= "\"" chars "\""
chars ::= char*
char ::= [^"\\] | "\\" (["\\/bfnrt] | "u" hex hex hex hex)
hex ::= [0-9a-fA-F]
ws ::= [ \t\n]*
'''.strip()

PLAN_TOOLS = (
    "browser_goto",
    "browser_read",
    "browser_click",
    "browser_type",
    "browser_submit",
    "done",
)
