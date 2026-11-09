"""Validate PLCopen XML files against the TC6 v2.01 schema.

Usage: python tools/validate_plcopen.py <tc6_xml_v201.xsd> <file.xml> [...]
Needs lxml (pip install lxml). The schema ships with OpenPLC Editor / Beremiz
(plcopen/tc6_xml_v201.xsd). Exit code 1 if any file is invalid.
"""
import sys

from lxml import etree


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    schema = etree.XMLSchema(etree.parse(sys.argv[1]))
    bad = 0
    for path in sys.argv[2:]:
        doc = etree.parse(path)
        if schema.validate(doc):
            print(f"VALID   {path}")
        else:
            bad += 1
            print(f"INVALID {path}")
            for e in schema.error_log:
                print(f"  line {e.line}: {e.message}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
