"""Distill the supplied Word reference without rebuilding its style package."""
from copy import deepcopy
from pathlib import Path
import sys
from zipfile import ZipFile, ZIP_DEFLATED
from lxml import etree as E

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
NS = {'w': W}

def replace_text(p, text):
    props = deepcopy(p.find('w:r/w:rPr', NS))
    for child in list(p):
        if child.tag != f'{{{W}}}pPr':
            p.remove(child)
    r = E.SubElement(p, f'{{{W}}}r')
    if props is not None:
        r.append(props)
    E.SubElement(r, f'{{{W}}}t').text = text

def main():
    source, target = map(Path, sys.argv[1:3])
    with ZipFile(source) as z:
        parts = {name: z.read(name) for name in z.namelist()}
    root = E.fromstring(parts['word/document.xml'])
    body = root.find('w:body', NS)
    ps = body.findall('w:p', NS)
    for index, token in {1:'TITLE', 2:'GENERATED', 7:'TOTALS', 10:'ORBIT_SOURCE', 11:'WEATHER_SOURCE'}.items():
        replace_text(ps[index], '{{' + token + '}}')
    tables = body.findall('w:tbl', NS)
    for i, row in enumerate(tables[0].findall('w:tr', NS)):
        for col in (1, 3):
            replace_text(row.findall('w:tc', NS)[col].find('w:p', NS), f'{{{{SUMMARY_{i}_{col}}}}}')
    for index, keep in ((1, 2), (2, 3)):
        rows = tables[index].findall('w:tr', NS)
        for row in rows[keep:]:
            tables[index].remove(row)
        replace_text(rows[0].find('w:tc/w:p', NS), '日期')
        for cell in rows[keep-1].findall('w:tc', NS):
            replace_text(cell.find('w:p', NS), '{{VALUE}}')
        if index == 2:
            replace_text(rows[1].find('w:tc/w:p', NS), '{{FAMILY}}')
    parts['word/document.xml'] = E.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)
    core = E.fromstring(parts['docProps/core.xml'])
    for node in list(core):
        core.remove(node)
    parts['docProps/core.xml'] = E.tostring(core, xml_declaration=True, encoding='UTF-8', standalone=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, 'w', ZIP_DEFLATED) as z:
        for name, value in parts.items():
            z.writestr(name, value)
    print(f'Template created: {target}; retained {len(parts)} package parts')

if __name__ == '__main__':
    main()
