"""
Smallest possible use of uibridge. No dependencies - stdlib only.

    python examples/hello.py

Needs two things first:
  1. node bin/uibridge.mjs login gemini   (once, ever - you sign in yourself)
  2. npm run serve                        (another terminal - it is the server)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _client import call, require_server  # noqa: E402

require_server()

print("asking gemini...\n")
res = call("In one sentence: what is a systematic review?")
print(res["text"])
print(f"\n({res['ms'] / 1000:.1f}s)")
