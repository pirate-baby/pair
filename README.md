# Pair

_"Walk me through how our caching works across regions"_

_"Why are there two User models?"_

_"Let's really dig into how thumbprint extraction works"_

Pair is an MCP that allows agents to walk you through code the way a human would - by scrolling and highlighting in the codebase as they explain answers to your questions. 

The agent controls the cursor and can navigate the file expolorer and code editor as it narrates. 
Interrupt any time to divert the conversation, then return to the original answer with a click. 


https://github.com/user-attachments/assets/d4865547-c69d-45f3-8a83-efeb903307b4



Uses your agent harness and then either browser native voice or (optionally) Kokoro as a really good local voice model. 

The first time you select Kokoro expect a delay (5-10 min on most connections) while it initially downloads the model. Future use will be near-instant.

## Installation
This will install `pair` as an MCP, add the MCP to claude code, opencode and codex (if present, skipped if not), and matching skills in each.

```
git clone git@github.com:pirate-baby/pair.git
cd pair && ./install.sh
```

## Usage
In your harness of choice, tell the agent to walk you through or explain some part of your repo. Pair takes it from there. 



## License

[MIT](LICENSE)
