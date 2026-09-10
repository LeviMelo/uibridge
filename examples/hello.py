"""
The smallest useful program.

    python examples/hello.py

Once, before the first run:
    uibridge login gemini     (a browser window opens - you sign in yourself)
    pip install -e python     (from the uibridge folder)

The first call starts uibridge in the background if it is not running yet.
"""
try:
    import uibridge
except ImportError:  # not pip-installed yet: use the copy in this repository
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
    import uibridge

answer = uibridge.ask("In one sentence: what is a systematic review?", model="gemini-pro")

print(answer)
print(f"\n({answer.seconds:.1f}s, model verified: {answer.model_verified})")
for note in answer.warnings:
    print("note:", note)
