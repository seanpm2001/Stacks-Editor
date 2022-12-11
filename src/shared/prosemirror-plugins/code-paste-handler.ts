import { Plugin, EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Slice, Node, DOMParser, Schema } from "prosemirror-model";
import { richTextSchemaSpec } from "../../rich-text/schema";

// create a static, mini schema for detecting code blocks in clipboard content
const miniSchema = new Schema({
    nodes: {
        doc: richTextSchemaSpec.nodes.doc,
        text: richTextSchemaSpec.nodes.text,
        paragraph: richTextSchemaSpec.nodes.paragraph,
        code_block: richTextSchemaSpec.nodes.code_block,
    },
});

function getHtmlClipboardContent(clipboardData: DataTransfer) {
    if (!clipboardData.types.includes("text/html")) {
        return null;
    }

    return new globalThis.DOMParser().parseFromString(
        clipboardData.getData("text/html"),
        "text/html"
    );
}

/**
 * Detects if code was pasted into the document and returns the text if true
 * @param clipboardData The clipboardData from the ClipboardEvent
 */
function getDetectedCode(
    clipboardData: DataTransfer,
    htmlDoc: Document
): string | null {
    // if we're loading a whole document, don't false positive if there's more than just code
    const codeEl = htmlDoc?.querySelector("code");
    if (htmlDoc && codeEl) {
        return htmlDoc.body.textContent.trim() !== codeEl.textContent
            ? null
            : codeEl.textContent;
    }

    const textContent = clipboardData.getData("text/plain");

    if (!textContent) {
        return null;
    }

    // TODO how to reliably detect if a string is code?

    // TODO add more support?
    // check if there's ide specific paste data present
    if (clipboardData.getData("vscode-editor-data")) {
        // TODO parse data for language?
        return textContent;
    }

    // no ide detected, try detecting leading indentation
    // true if any line starts with: 2+ space characters, 1 tab character
    if (/^([ ]{2,}|\t)/m.test(textContent)) {
        return textContent;
    }

    return null;
}

/**
 * Parses a code string from pasted text, based on multiple heuristics
 * @param clipboardData The ClipboardEvent.clipboardData from the clipboard paste event
 * @param doc Pre-parsed slice, if already available; otherwise the slice will be parsed from the clipboard's html data
 * @internal
 */
export function parseCodeFromPasteData(
    clipboardData: DataTransfer,
    doc?: Slice | Node
) {
    let codeData: string;

    let htmlContent: Document | null = null;
    if (!doc) {
        htmlContent = getHtmlClipboardContent(clipboardData);

        if (htmlContent) {
            doc = DOMParser.fromSchema(miniSchema).parse(htmlContent);
        }
    }

    // if the schema parser already detected a code block, just use that
    if (
        doc &&
        doc.content.childCount === 1 &&
        doc.content.child(0).type.name === "code_block"
    ) {
        codeData = doc.content.child(0).textContent;
    } else {
        // if not parsed above, parse here - this allows us to only run the parse when it is necessary
        htmlContent ??= getHtmlClipboardContent(clipboardData);
        codeData = getDetectedCode(clipboardData, htmlContent);
    }

    if (!codeData) {
        return null;
    }

    // TODO can we do some basic formatting?

    return codeData;
}

/**
 * Calculates the range of text that should be replaced when inserting code data.
 * If the state selection is between backticks, the range will be expanded to include the backticks.
 * @param editorState The state of the editor
 */
export function getInsertionRange(editorState: EditorState): {
    from: number;
    to: number;
} {
    const { selection } = editorState;

    const textBeforeSelection = editorState.doc.textBetween(
        selection.$from.before(),
        selection.$from.pos
    );
    const textAfterSelection = editorState.doc.textBetween(
        selection.$to.pos,
        selection.$to.after()
    );

    const whitespacesBeforeSelectionCount =
        textBeforeSelection.length - textBeforeSelection.trimEnd().length;
    const whitespacesAfterSelectionCount =
        textAfterSelection.length - textAfterSelection.trimStart().length;

    const selectionPlusWhitespaces = {
        from: selection.from - whitespacesBeforeSelectionCount,
        to: selection.to + whitespacesAfterSelectionCount,
    };

    const isSelectionBetweenBackticks =
        editorState.doc.textBetween(
            selectionPlusWhitespaces.from - 1,
            selectionPlusWhitespaces.from
        ) === "`" &&
        editorState.doc.textBetween(
            selectionPlusWhitespaces.to,
            selectionPlusWhitespaces.to + 1
        ) === "`";

    return {
        from: isSelectionBetweenBackticks
            ? selectionPlusWhitespaces.from - 1
            : selection.from,
        to: isSelectionBetweenBackticks
            ? selectionPlusWhitespaces.to + 1
            : selection.to,
    };
}

/** Plugin for the rich-text editor that auto-detects if code was pasted and handles it specifically */
export const richTextCodePasteHandler = new Plugin({
    props: {
        handlePaste(view: EditorView, event: ClipboardEvent, slice: Slice) {
            // if we're pasting into an existing code block, don't bother checking for code
            const schema = view.state.schema;
            const codeblockType = schema.nodes.code_block;
            const currNodeType = view.state.selection.$from.node().type;
            if (currNodeType === codeblockType) {
                return false;
            }

            const codeData = parseCodeFromPasteData(event.clipboardData, slice);

            if (!codeData) {
                return false;
            }

            const node = codeblockType.createChecked({}, schema.text(codeData));
            view.dispatch(view.state.tr.replaceSelectionWith(node));

            return true;
        },
    },
});

/** Plugin for the commonmark editor that auto-detects if code was pasted and handles it specifically */
export const commonmarkCodePasteHandler = new Plugin({
    props: {
        handlePaste(view: EditorView, event: ClipboardEvent) {
            // unlike the rich-text schema, the commonmark schema doesn't allow code_blocks in the root node
            // so pass in a null slice so the code manually parses instead
            let codeData = parseCodeFromPasteData(event.clipboardData, null);

            if (!codeData) {
                return false;
            }

            const { from, to } = getInsertionRange(view.state);

            // wrap the code in a markdown code fence
            codeData = "```\n" + codeData + "\n```\n";

            // add a newline if we're not at the beginning of the document
            codeData = (from === 1 ? "" : "\n") + codeData;

            view.dispatch(view.state.tr.insertText(codeData, from, to));

            return true;
        },
    },
});
