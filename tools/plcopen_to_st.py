"""Converts a PLCopen XML project to IEC 61131-3 Structured Text with the
OpenPLC Editor / Beremiz program generator, the same step the editor runs
before handing the program to matiec.

    python tools/plcopen_to_st.py <path-to-openplc-editor> <in.xml> <out.st>

Used by the CI job in .github/workflows/iec.yml. Needs lxml.
"""
import os
import sys


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    editor, src, dst = (os.path.abspath(a) for a in sys.argv[1:])
    sys.path.insert(0, editor)
    import fake_wx  # noqa: F401  (stubs out wxPython so the editor modules import headless)
    # Same import order as the editor's own CLI (Beremiz_cli -> CLIController):
    # loading ProjectController first avoids a circular import in the GUI modules.
    import ProjectController  # noqa: F401
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
