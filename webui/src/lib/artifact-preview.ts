// A report that fails to run looks exactly like a report with nothing to say:
// the shell renders, every container the script was meant to fill stays empty,
// and nothing anywhere says why. One delivered report spent an afternoon being
// diagnosed as missing data when the page had all 43 rows inside it and a
// single line -- `const top = ...` at the top level of a script, where `top` is
// already a property of `window` -- threw a SyntaxError that discarded the
// whole block before its first statement ran.
//
// The preview cannot fix such a page, but it can stop hiding the reason. A
// short script inserted ahead of the document's own listens for the error and
// draws it. It runs inside the same sandboxed, opaque-origin document as the
// report, so it needs no privilege the report does not already have.

const BANNER_SCRIPT = `<script>(function(){
var shown=false;
function show(text){
  if(shown)return;shown=true;
  var host=document.body||document.documentElement;
  if(!host)return;
  var bar=document.createElement('div');
  bar.setAttribute('data-preview-error','1');
  bar.style.cssText='position:sticky;top:0;z-index:2147483647;background:#7f1d1d;color:#fff;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px 14px;white-space:pre-wrap;word-break:break-word';
  bar.textContent='This report stopped before it finished rendering, so parts of the page are empty.\\n'+text;
  host.insertBefore(bar,host.firstChild);
}
addEventListener('error',function(event){
  var message=event&&(event.message||(event.error&&event.error.message));
  show(message||'A script in this file failed.');
},true);
addEventListener('unhandledrejection',function(event){
  var reason=event&&event.reason;
  show('Unhandled promise rejection: '+((reason&&reason.message)||reason||'unknown'));
});
})();<\/script>`;

/**
 * Insert the reporter ahead of the document's own scripts.
 *
 * Position matters twice. It has to come before the scripts it reports on,
 * because `error` events are not replayed to a listener that registered late.
 * And it must not come before the doctype: a document whose first bytes are a
 * `<script>` is parsed in quirks mode, which silently changes the layout of the
 * page being previewed.
 */
export function withScriptErrorReporter(html: string): string {
  if (!html.trim()) return html;

  const head = /<head\b[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + BANNER_SCRIPT + html.slice(at);
  }

  // No `<head>` to open. `<body>` is the next honest anchor; anything earlier
  // risks the quirks-mode change above.
  const body = /<body\b[^>]*>/i.exec(html);
  if (body) {
    const at = body.index + body[0].length;
    return html.slice(0, at) + BANNER_SCRIPT + html.slice(at);
  }

  const html_ = /<html\b[^>]*>/i.exec(html);
  if (html_) {
    const at = html_.index + html_[0].length;
    return html.slice(0, at) + BANNER_SCRIPT + html.slice(at);
  }

  // A fragment rather than a document. The parser will build the tree around
  // it, and there is no doctype to displace.
  return BANNER_SCRIPT + html;
}
