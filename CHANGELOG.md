# Changelog

## fix(hooks): Coalesce hook feedback into one prompt (`c0f4ba61`)

Buffer post-tool and agent-stop feedback during an agent run and deliver it as
one ordered follow-up prompt, preventing one queued turn per hook result.
