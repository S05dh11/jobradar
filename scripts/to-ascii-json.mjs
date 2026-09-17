// 把 UTF-8 JSON 文件转成纯 ASCII(\u 转义)版,规避 curl/Git Bash 中文编码坑
import { readFileSync, writeFileSync } from "node:fs";
const [,, inPath] = process.argv;
let s = readFileSync(inPath, "utf8").replace(/^﻿/, "");
s = JSON.stringify(JSON.parse(s)); // 顺带规范化 + 去 BOM
const esc = s.replace(/[^\x00-\x7f]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
writeFileSync(inPath, esc);
console.log(esc);
