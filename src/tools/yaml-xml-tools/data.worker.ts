/**
 * YAML and XML processing off the main thread. The YAML parser is the one bundled dependency; it
 * loads only inside this worker, and only when the YAML/XML tool is used.
 */
import type { DataResult } from '../../core/data/data-result';
import { formatXml, validateXml, xmlToJson } from '../../core/data/xml-tools';
import { formatYaml, jsonToYaml, yamlToJson, type YamlIndent } from '../../core/data/yaml';
import { serve } from '../util-shared/worker-host';

export type DataOperation = 'yaml-format' | 'yaml-json' | 'json-yaml' | 'xml-format' | 'xml-minify' | 'xml-json';

export interface DataRequest {
  readonly operation: DataOperation;
  readonly text: string;
  /** '2', '4' or 'tab'. YAML cannot be indented with tabs, so YAML output uses 2 for 'tab'. */
  readonly indent: '2' | '4' | 'tab';
  readonly keepWhitespace: boolean;
}

serve<DataRequest, DataResult>(request => {
  const spaces: YamlIndent = request.indent === '4' ? 4 : 2;
  const indent = request.indent === 'tab' ? String.fromCharCode(0x09) : ' '.repeat(spaces);
  switch (request.operation) {
    case 'yaml-format': return formatYaml(request.text, spaces);
    case 'yaml-json': return yamlToJson(request.text, indent);
    case 'json-yaml': return jsonToYaml(request.text, spaces);
    case 'xml-format': return request.text.trim() === '' ? validateXml(request.text) : formatXml(request.text, indent);
    case 'xml-minify': return formatXml(request.text, null);
    case 'xml-json': return xmlToJson(request.text, { indent, keepWhitespace: request.keepWhitespace });
  }
});
