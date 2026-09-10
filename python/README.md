# uibridge for Python

```python
import uibridge

answer = uibridge.ask("What is a systematic review?", model="gemini-pro")
print(answer)
```

A thin, dependency-free client for the uibridge daemon running on this
machine. Install it once, from the uibridge folder:

```bash
pip install -e python
```

**The full guide - setup, every option, errors and what to do about them - is
[`docs/PYTHON.md`](../docs/PYTHON.md).**

Tests (offline; they start their own throwaway daemon and never touch a real
site):

```bash
python -m unittest discover -s python/tests -v
```
