"""
Smallest possible use of uibridge. No dependencies - stdlib only.

    python examples/hello.py

Needs two things running first:
  1. npm run serve          (in another terminal - it is the server)
  2. node login.mjs gemini  (once, ever - signs you in)
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
