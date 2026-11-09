"""Converts a PLCopen XML project to IEC 61131-3 Structured Text with the
OpenPLC Editor / Beremiz program generator, the same step the editor runs
before handing the program to matiec.

    python tools/plcopen_to_st.py <path-to-openplc-editor> <in.xml> <out.st>

Used by the CI job in .github/workflows/iec.yml. Needs lxml.
"""
import os
import sys

# Modules the generator itself needs: fail loudly instead of stubbing them.
NEEDED = {"lxml", "plcopen", "PLCGenerator", "PLCControler", "util", "jinja2"}


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    editor, src, dst = (os.path.abspath(a) for a in sys.argv[1:])
    sys.path.insert(0, editor)
    import fake_wx  # noqa: F401  (stubs out wxPython so the editor modules import headless)
    # Same import order as the editor's own CLI (Beremiz_cli -> CLIController):
    # loading ProjectController first avoids a circular import in the GUI modules.
    # The GUI modules pull in packages the code generator never uses (zeroconf,
    # Pyro5, ...); stub those instead of installing the editor's whole stack.
    stubbed = []
    for _ in range(50):
        try:
            import ProjectController  # noqa: F401
            break
        except ModuleNotFoundError as e:
            name = e.name or ""
            if not name or name.split(".")[0] in NEEDED or name in stubbed:
                raise
            for i in range(1, name.count(".") + 2):
                part = ".".join(name.split(".")[:i])
                sys.modules.setdefault(part, fake_wx.FakeModule(part, []))
            stubbed.append(name)
            for m in [m for m, mod in sys.modules.items()
                      if (getattr(mod, "__file__", None) or "").startswith(editor)]:
                del sys.modules[m]
            import fake_wx as _fw  # re-import after the purge so the stubs stay registered
    if stubbed:
        print("stubbed GUI-only modules: " + ", ".join(stubbed))
    from PLCControler import PLCControler

    ctl = PLCControler()
    err = ctl.OpenXMLFile(src)
    if err:
        print(f"{src}: cannot open: {err}")
        return 1
    _, errors, warnings = ctl.GenerateProgram(dst)
    for w in warnings:
        print(f"{src}: warning: {w}")
    for e in errors:
        print(f"{src}: error: {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
