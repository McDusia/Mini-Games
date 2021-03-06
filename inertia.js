/*
 * emccpre.js: one of the Javascript components of an Emscripten-based
 * web/Javascript front end for Puzzles.
 *
 * The other parts of this system live in emcc.c and emcclib.js. It
 * also depends on being run in the context of a web page containing
 * an appropriate collection of bits and pieces (a canvas, some
 * buttons and links etc), which is generated for each puzzle by the
 * script html/jspage.pl.
 *
 * This file contains the Javascript code which is prefixed unmodified
 * to Emscripten's output via the --pre-js option. It declares all our
 * global variables, and provides the puzzle init function and a
 * couple of other helper functions.
 */
var global_width = 8;
var global_height = 8;
var points = 0;

// To avoid flicker while doing complicated drawing, we use two
// canvases, the same size. One is actually on the web page, and the
// other is off-screen. We do all our drawing on the off-screen one
// first, and then copy rectangles of it to the on-screen canvas in
// response to draw_update() calls by the game backend.
var onscreen_canvas, offscreen_canvas;

// A persistent drawing context for the offscreen canvas, to save
// constructing one per individual graphics operation.
var ctx;

// Bounding rectangle for the copy to the onscreen canvas that will be
// done at drawing end time. Updated by js_canvas_draw_update and used
// by js_canvas_end_draw.
var update_xmin, update_xmax, update_ymin, update_ymax;

// Module object for Emscripten. We fill in these parameters to ensure
// that Module.run() won't be called until we're ready (we want to do
// our own init stuff first), and that when main() returns nothing
// will get cleaned up so we remain able to call the puzzle's various
// callbacks.
var Module = {
    'noInitialRun': true,
    'noExitRuntime': true
};

// Variables used by js_canvas_find_font_midpoint().
var midpoint_test_str = "ABCDEFGHIKLMNOPRSTUVWXYZ0123456789";
var midpoint_cache = [];

// Variables used by js_activate_timer() and js_deactivate_timer().
var timer = null;
var timer_reference_date;

//void timer_callback(double tplus){


//
// Called every 20ms while timing is active.
var timer_callback;

// The status bar object, if we create one.
var statusbar = null;

// Currently live blitters. We keep an integer id for each one on the
// JS side; the C side, which expects a blitter to look like a struct,
// simply defines the struct to contain that integer id.
var blittercount = 0;
var blitters = [];

// State for the dialog-box mechanism. dlg_dimmer and dlg_form are the
// page-darkening overlay and the actual dialog box respectively;
// dlg_next_id is used to allocate each checkbox a unique id to use
// for linking its label to it (see js_dialog_boolean);
// dlg_return_funcs is a list of JS functions to be called when the OK
// button is pressed, to pass the results back to C.
var dlg_dimmer = null, dlg_form = null;
var dlg_next_id = 0;
var dlg_return_funcs = null;

// void dlg_return_sval(int index, const char *val);
// void dlg_return_ival(int index, int val);
//
// C-side entry points called by functions in dlg_return_funcs, to
// pass back the final value in each dialog control.
var dlg_return_sval, dlg_return_ival;

// The <ul> object implementing the game-type drop-down, and a list of
// the <li> objects inside it. Used by js_add_preset(),
// js_get_selected_preset() and js_select_preset().
var gametypelist = null, gametypeitems = [];
var gametypeselectedindex = 0;//null;
var gametypesubmenus = [];

// The two anchors used to give permalinks to the current puzzle. Used
// by js_update_permalinks().
var permalink_seed, permalink_desc;

// The undo and redo buttons. Used by js_enable_undo_redo().
var undo_button, redo_button;

// A div element enclosing both the puzzle and its status bar, used
// for positioning the resize handle.
var resizable_div;

function changeSize(width, height){
    document.getElementById("gametype").getElementsByTagName("li")[3].click();
    document.getElementsByTagName("input")[0].value = width;
    document.getElementsByTagName("input")[1].value = height;
    document.getElementsByTagName("form")[0].getElementsByTagName("input")[2].click();
}

function displayHelpModal(){
    var modal = document.getElementById('helpModal');
    modal.style.display = "block";
}


function closeHelpModal(){
    var modal = document.getElementById('helpModal');
    modal.style.display = "none";
}

// Helper function to find the absolute position of a given DOM
// element on a page, by iterating upwards through the DOM finding
// each element's offset from its parent, and thus calculating the
// page-relative position of the target element.
function element_coords(element) {
    var ex = 0, ey = 0;
    while (element.offsetParent) {
        ex += element.offsetLeft;
        ey += element.offsetTop;
        element = element.offsetParent;
    }
    return {x: ex, y:ey};
}

// Helper function which is passed a mouse event object and a DOM
// element, and returns the coordinates of the mouse event relative to
// the top left corner of the element by subtracting element_coords
// from event.page{X,Y}.
function relative_mouse_coords(event, element) {
    var ecoords = element_coords(element);
    return {x: event.pageX - ecoords.x,
        y: event.pageY - ecoords.y};
}

// Enable and disable items in the CSS menus.
function disable_menu_item(item, disabledFlag) {
    if (disabledFlag)
        item.className = "disabled";
    else
        item.className = "";
}

// Dialog-box functions called from both C and JS.
function dialog_init(titletext) {
    // Create an overlay on the page which darkens everything
    // beneath it.
    dlg_dimmer = document.createElement("div");
    dlg_dimmer.style.width = "100%";
    dlg_dimmer.style.height = "100%";
    dlg_dimmer.style.background = '#000000';
    dlg_dimmer.style.position = 'fixed';
    dlg_dimmer.style.opacity = 0.3;
    dlg_dimmer.style.top = dlg_dimmer.style.left = 0;
    dlg_dimmer.style["z-index"] = 99;

    // Now create a form which sits on top of that in turn.
    dlg_form = document.createElement("form");
    dlg_form.style.width = (window.innerWidth * 2 / 3) + "px";
    dlg_form.style.opacity = 1;
    dlg_form.style.background = '#ffffff';
    dlg_form.style.color = '#000000';
    dlg_form.style.position = 'absolute';
    dlg_form.style.border = "2px solid black";
    dlg_form.style.padding = "20px";
    dlg_form.style.top = (window.innerHeight / 10) + "px";
    dlg_form.style.left = (window.innerWidth / 6) + "px";
    dlg_form.style["z-index"] = 100;

    var title = document.createElement("p");
    title.style.marginTop = "0px";
    title.appendChild(document.createTextNode(titletext));
    dlg_form.appendChild(title);

    dlg_return_funcs = [];
    dlg_next_id = 0;
}

function dialog_launch(ok_function, cancel_function) {
    // Put in the OK and Cancel buttons at the bottom.
    var button;

    if (ok_function) {
        button = document.createElement("input");
        button.type = "button";
        button.value = "OK";
        button.onclick = ok_function;
        dlg_form.appendChild(button);
    }

    if (cancel_function) {
        button = document.createElement("input");
        button.type = "button";
        button.value = "Cancel";
        button.onclick = cancel_function;
        dlg_form.appendChild(button);
    }

    document.body.appendChild(dlg_dimmer);
    document.body.appendChild(dlg_form);
}

function dialog_cleanup() {
    document.body.removeChild(dlg_dimmer);
    document.body.removeChild(dlg_form);
    dlg_dimmer = dlg_form = null;
    onscreen_canvas.focus();
}

// Init function called from body.onload.
function initPuzzle() {
    /*if (config['age'] < 8) {
        global_width = 5;
        global_height = 5;
    }
    else if (config['age'] < 15) {
        global_width = 6;
        global_height = 6;
    }
    else if (config['age'] < 20) {
        global_width = 7;
        global_height = 7;
    }
    else {
        global_width = 8;
        global_height = 8;
    }*/
	
    // Construct the off-screen canvas used for double buffering.
    onscreen_canvas = document.getElementById("puzzlecanvas");
    offscreen_canvas = document.createElement("canvas");
    offscreen_canvas.width = onscreen_canvas.width;
    offscreen_canvas.height = onscreen_canvas.height;

    // Stop right-clicks on the puzzle from popping up a context menu.
    // We need those right-clicks!
    onscreen_canvas.oncontextmenu = function(event) { return false; }

    // Set up mouse handlers. We do a bit of tracking of the currently
    // pressed mouse buttons, to avoid sending mousemoves with no
    // button down (our puzzles don't want those events).
    mousedown = Module.cwrap('mousedown', 'void',
        ['number', 'number', 'number']);

    button_phys2log = [null, null, null];
    buttons_down = function() {
        var i, toret = 0;
        for (i = 0; i < 3; i++)
            if (button_phys2log[i] !== null)
                toret |= 1 << button_phys2log[i];
        return toret;
    };

    onscreen_canvas.onmousedown = function(event) {
        if (event.button >= 3)
            return;

        var xy = relative_mouse_coords(event, onscreen_canvas);
        var logbutton = event.button;
        if (event.shiftKey)
            logbutton = 1;   // Shift-click overrides to middle button
        else if (event.ctrlKey)
            logbutton = 2;   // Ctrl-click overrides to right button

        mousedown(xy.x, xy.y, logbutton);
        button_phys2log[event.button] = logbutton;

        onscreen_canvas.setCapture(true);
    };
    mousemove = Module.cwrap('mousemove', 'void',
        ['number', 'number', 'number']);
    onscreen_canvas.onmousemove = function(event) {
        var down = buttons_down();
        if (down) {
            var xy = relative_mouse_coords(event, onscreen_canvas);
            mousemove(xy.x, xy.y, down);
        }
    };
    mouseup = Module.cwrap('mouseup', 'void',
        ['number', 'number', 'number']);
    onscreen_canvas.onmouseup = function(event) {
        if (event.button >= 3)
            return;

        if (button_phys2log[event.button] !== null) {
            var xy = relative_mouse_coords(event, onscreen_canvas);
            mouseup(xy.x, xy.y, button_phys2log[event.button]);
            button_phys2log[event.button] = null;
        }
    };

    // Set up keyboard handlers. We do all the actual keyboard
    // handling in onkeydown; but we also call event.preventDefault()
    // in both the keydown and keypress handlers. This means that
    // while the canvas itself has focus, _all_ keypresses go only to
    // the puzzle - so users of this puzzle collection in other media
    // can indulge their instinct to press ^R for redo, for example,
    // without accidentally reloading the page.
    key = Module.cwrap('key', 'void', ['number', 'number', 'string',
        'string', 'number', 'number']);
    onscreen_canvas.onkeydown = function(event) {
        key(event.keyCode, event.charCode, event.key, event.char,
            event.shiftKey ? 1 : 0, event.ctrlKey ? 1 : 0);
        event.preventDefault();
    };
    onscreen_canvas.onkeypress = function(event) {
        event.preventDefault();
    };

    // command() is a C function called to pass back events which
    // don't fall into other categories like mouse and key events.
    // Mostly those are button presses, but there's also one for the
    // game-type dropdown having been changed.
    command = Module.cwrap('command', 'void', ['number']);

    // Event handlers for buttons and things, which call command().
    /*document.getElementById("specific").onclick = function(event) {
        // Ensure we don't accidentally process these events when a
        // dialog is actually active, e.g. because the button still
        // has keyboard focus
        if (dlg_dimmer === null)
            command(0);
    };
	*/
    /*document.getElementById("random").onclick = function(event) {
        if (dlg_dimmer === null)
            command(1);
    };*/
    document.getElementById("new").onclick = function(event) {
        if (dlg_dimmer === null){
            preloadStartTime = Date.now();
            command(5);
        }
    };
    document.getElementById("restart").onclick = function(event) {
        if (dlg_dimmer === null){
            preloadStartTime = Date.now();
            command(6);
        }
    };
    undo_button = document.getElementById("undo");
    undo_button.onclick = function(event) {
        if (dlg_dimmer === null)
            command(7);
    };
    redo_button = document.getElementById("redo");
    redo_button.onclick = function(event) {
        if (dlg_dimmer === null)
            command(8);
    };
    document.getElementById("solve").onclick = function(event) {
        if (dlg_dimmer === null)
            command(9);
    };

    // 'number' is used for C pointers
    get_save_file = Module.cwrap('get_save_file', 'number', []);
    free_save_file = Module.cwrap('free_save_file', 'void', ['number']);
    load_game = Module.cwrap('load_game', 'void', ['string', 'number']);

    /*document.getElementById("save").onclick = function(event) {
        if (dlg_dimmer === null) {
            var savefile_ptr = get_save_file();
            var savefile_text = Pointer_stringify(savefile_ptr);
            free_save_file(savefile_ptr);
            dialog_init("Download saved-game file");
            dlg_form.appendChild(document.createTextNode(
                "Click to download the "));
            var a = document.createElement("a");
            a.download = "puzzle.sav";
            a.href = "data:application/octet-stream," +
                encodeURIComponent(savefile_text);
            a.appendChild(document.createTextNode("saved-game file"));
            dlg_form.appendChild(a);
            dlg_form.appendChild(document.createTextNode("."));
            dlg_form.appendChild(document.createElement("br"));
            dialog_launch(function(event) {
                dialog_cleanup();
            });
        }
    };

    document.getElementById("load").onclick = function(event) {
        if (dlg_dimmer === null) {
            dialog_init("Upload saved-game file");
            var input = document.createElement("input");
            input.type = "file";
            input.multiple = false;
            dlg_form.appendChild(input);
            dlg_form.appendChild(document.createElement("br"));
            dialog_launch(function(event) {
                if (input.files.length == 1) {
                    var file = input.files.item(0);
                    var reader = new FileReader();
                    reader.addEventListener("loadend", function() {
                        var string = reader.result;
                        load_game(string, string.length);
                    });
                    reader.readAsBinaryString(file);
                }
                dialog_cleanup();
            }, function(event) {
                dialog_cleanup();
            });
        }
    };*/

    gametypelist = document.getElementById("gametype");
    gametypesubmenus.push(gametypelist);

    // In IE, the canvas doesn't automatically gain focus on a mouse
    // click, so make sure it does
    onscreen_canvas.addEventListener("mousedown", function(event) {
        onscreen_canvas.focus();
    });

    // In our dialog boxes, Return and Escape should be like pressing
    // OK and Cancel respectively
    document.addEventListener("keydown", function(event) {

        if (dlg_dimmer !== null && event.keyCode == 13) {
            for (var i in dlg_return_funcs)
                dlg_return_funcs[i]();
            command(3);
        }

        if (dlg_dimmer !== null && event.keyCode == 27)
            command(4);
    });

    // Set up the function pointers we haven't already grabbed.
    dlg_return_sval = Module.cwrap('dlg_return_sval', 'void',
        ['number','string']);
    dlg_return_ival = Module.cwrap('dlg_return_ival', 'void',
        ['number','number']);
    timer_callback = Module.cwrap('timer_callback', 'void', ['number']);

    // Save references to the two permalinks.
    //permalink_desc = document.getElementById("permalink-desc");
    //permalink_seed = document.getElementById("permalink-seed");

    // Default to giving keyboard focus to the puzzle.
    onscreen_canvas.focus();

    // Create the resize handle.
    var resize_handle = document.createElement("canvas");
    resize_handle.width = 10;
    resize_handle.height = 10;
    {
        var ctx = resize_handle.getContext("2d");
        ctx.beginPath();
        for (var i = 1; i <= 7; i += 3) {
            ctx.moveTo(8.5, i + 0.5);
            ctx.lineTo(i + 0.5, 8.5);
        }
        ctx.lineWidth = '1px';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#000000';
        ctx.stroke();
    }
    resizable_div = document.getElementById("resizable");
    resizable_div.appendChild(resize_handle);
    resize_handle.style.position = 'absolute';
    resize_handle.style.zIndex = 98;
    resize_handle.style.bottom = "0";
    resize_handle.style.right = "0";
    resize_handle.style.cursor = "se-resize";
    resize_handle.title = "Drag to resize the puzzle. Right-click to restore the default size.";
    var resize_xbase = null, resize_ybase = null, restore_pending = false;
    var resize_xoffset = null, resize_yoffset = null;
    var resize_puzzle = Module.cwrap('resize_puzzle',
        'void', ['number', 'number']);
    var restore_puzzle_size = Module.cwrap('restore_puzzle_size', 'void', []);
    resize_handle.oncontextmenu = function(event) { return false; }
    resize_handle.onmousedown = function(event) {
        if (event.button == 0) {
            var xy = element_coords(onscreen_canvas);
            resize_xbase = xy.x + onscreen_canvas.width / 2;
            resize_ybase = xy.y;
            resize_xoffset = xy.x + onscreen_canvas.width - event.pageX;
            resize_yoffset = xy.y + onscreen_canvas.height - event.pageY;
        } else {
            restore_pending = true;
        }
        resize_handle.setCapture(true);
        event.preventDefault();
    };
    window.addEventListener("mousemove", function(event) {
        if (resize_xbase !== null && resize_ybase !== null) {
            resize_puzzle((event.pageX + resize_xoffset - resize_xbase) * 2,
                (event.pageY + resize_yoffset - resize_ybase));
            event.preventDefault();
            // Chrome insists on selecting text during a resize drag
            // no matter what I do
            if (window.getSelection)
                window.getSelection().removeAllRanges();
            else
                document.selection.empty();        }
    });
    window.addEventListener("mouseup", function(event) {
        if (resize_xbase !== null && resize_ybase !== null) {
            resize_xbase = null;
            resize_ybase = null;
            onscreen_canvas.focus(); // return focus to the puzzle
            event.preventDefault();
        } else if (restore_pending) {
            // If you have the puzzle at larger than normal size and
            // then right-click to restore, I haven't found any way to
            // stop Chrome and IE popping up a context menu on the
            // revealed piece of document when you release the button
            // except by putting the actual restore into a setTimeout.
            // Gah.
            setTimeout(function() {
                restore_pending = false;
                restore_puzzle_size();
                onscreen_canvas.focus();
            }, 20);
            event.preventDefault();
        }
    });

    // Run the C setup function, passing argv[1] as the fragment
    // identifier (so that permalinks of the form puzzle.html#game-id
    // can launch the specified id).
    Module.callMain([location.hash]);

    // And if we get here with everything having gone smoothly, i.e.
    // we haven't crashed for one reason or another during setup, then
    // it's probably safe to hide the 'sorry, no puzzle here' div and
    // show the div containing the actual puzzle.
    document.getElementById("apology").style.display = "none";
    document.getElementById("puzzle").style.display = "inline";
    //changeSize(global_width, global_height);
}

// The Module object: Our interface to the outside world. We import
// and export values on it, and do the work to get that through
// closure compiler if necessary. There are various ways Module can be used:
// 1. Not defined. We create it here
// 2. A function parameter, function(Module) { ..generated code.. }
// 3. pre-run appended it, var Module = {}; ..generated code..
// 4. External script tag defines var Module.
// We need to do an eval in order to handle the closure compiler
// case, where this code here is minified but Module was defined
// elsewhere (e.g. case 4 above). We also need to check if Module
// already exists (e.g. case 3 above).
// Note that if you want to run closure, and also to use Module
// after the generated code, you will need to define   var Module = {};
// before the code. Then that object will be used in the code, and you
// can continue to use Module afterwards as well.
var Module;
if (!Module) Module = (typeof Module !== 'undefined' ? Module : null) || {};

// Sometimes an existing Module object exists with properties
// meant to overwrite the default module functionality. Here
// we collect those properties and reapply _after_ we configure
// the current environment's defaults to avoid having to be so
// defensive during initialization.
var moduleOverrides = {};
for (var key in Module) {
    if (Module.hasOwnProperty(key)) {
        moduleOverrides[key] = Module[key];
    }
}

// The environment setup code below is customized to use Module.
// *** Environment setup code ***
var ENVIRONMENT_IS_NODE = typeof process === 'object' && typeof require === 'function';
var ENVIRONMENT_IS_WEB = typeof window === 'object';
var ENVIRONMENT_IS_WORKER = typeof importScripts === 'function';
var ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER;

if (ENVIRONMENT_IS_NODE) {
    // Expose functionality in the same simple way that the shells work
    // Note that we pollute the global namespace here, otherwise we break in node
    if (!Module['print']) Module['print'] = function print(x) {
        process['stdout'].write(x + '\n');
    };
    if (!Module['printErr']) Module['printErr'] = function printErr(x) {
        process['stderr'].write(x + '\n');
    };

    var nodeFS = require('fs');
    var nodePath = require('path');

    Module['read'] = function read(filename, binary) {
        filename = nodePath['normalize'](filename);
        var ret = nodeFS['readFileSync'](filename);
        // The path is absolute if the normalized version is the same as the resolved.
        if (!ret && filename != nodePath['resolve'](filename)) {
            filename = path.join(__dirname, '..', 'src', filename);
            ret = nodeFS['readFileSync'](filename);
        }
        if (ret && !binary) ret = ret.toString();
        return ret;
    };

    Module['readBinary'] = function readBinary(filename) { return Module['read'](filename, true) };

    Module['load'] = function load(f) {
        globalEval(read(f));
    };

    Module['arguments'] = process['argv'].slice(2);

    module['exports'] = Module;
}
else if (ENVIRONMENT_IS_SHELL) {
    if (!Module['print']) Module['print'] = print;
    if (typeof printErr != 'undefined') Module['printErr'] = printErr; // not present in v8 or older sm

    if (typeof read != 'undefined') {
        Module['read'] = read;
    } else {
        Module['read'] = function read() { throw 'no read() available (jsc?)' };
    }

    Module['readBinary'] = function readBinary(f) {
        return read(f, 'binary');
    };

    if (typeof scriptArgs != 'undefined') {
        Module['arguments'] = scriptArgs;
    } else if (typeof arguments != 'undefined') {
        Module['arguments'] = arguments;
    }

    this['Module'] = Module;

    eval("if (typeof gc === 'function' && gc.toString().indexOf('[native code]') > 0) var gc = undefined"); // wipe out the SpiderMonkey shell 'gc' function, which can confuse closure (uses it as a minified name, and it is then initted to a non-falsey value unexpectedly)
}
else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    Module['read'] = function read(url) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, false);
        xhr.send(null);
        return xhr.responseText;
    };

    if (typeof arguments != 'undefined') {
        Module['arguments'] = arguments;
    }

    if (typeof console !== 'undefined') {
        if (!Module['print']) Module['print'] = function print(x) {
            console.log(x);
        };
        if (!Module['printErr']) Module['printErr'] = function printErr(x) {
            console.log(x);
        };
    } else {
        // Probably a worker, and without console.log. We can do very little here...
        var TRY_USE_DUMP = false;
        if (!Module['print']) Module['print'] = (TRY_USE_DUMP && (typeof(dump) !== "undefined") ? (function(x) {
            dump(x);
        }) : (function(x) {
            // self.postMessage(x); // enable this if you want stdout to be sent as messages
        }));
    }

    if (ENVIRONMENT_IS_WEB) {
        window['Module'] = Module;
    } else {
        Module['load'] = importScripts;
    }
}
else {
    // Unreachable because SHELL is dependant on the others
    throw 'Unknown runtime environment. Where are we?';
}

function globalEval(x) {
    eval.call(null, x);
}
if (!Module['load'] == 'undefined' && Module['read']) {
    Module['load'] = function load(f) {
        globalEval(Module['read'](f));
    };
}
if (!Module['print']) {
    Module['print'] = function(){};
}
if (!Module['printErr']) {
    Module['printErr'] = Module['print'];
}
if (!Module['arguments']) {
    Module['arguments'] = [];
}
// *** Environment setup code ***

// Closure helpers
Module.print = Module['print'];
Module.printErr = Module['printErr'];

// Callbacks
Module['preRun'] = [];
Module['postRun'] = [];

// Merge back in the overrides
for (var key in moduleOverrides) {
    if (moduleOverrides.hasOwnProperty(key)) {
        Module[key] = moduleOverrides[key];
    }
}



// === Auto-generated preamble library stuff ===

//========================================
// Runtime code shared with compiler
//========================================

var Runtime = {
    stackSave: function () {
        return STACKTOP;
    },
    stackRestore: function (stackTop) {
        STACKTOP = stackTop;
    },
    forceAlign: function (target, quantum) {
        quantum = quantum || 4;
        if (quantum == 1) return target;
        if (isNumber(target) && isNumber(quantum)) {
            return Math.ceil(target/quantum)*quantum;
        } else if (isNumber(quantum) && isPowerOfTwo(quantum)) {
            return '(((' +target + ')+' + (quantum-1) + ')&' + -quantum + ')';
        }
        return 'Math.ceil((' + target + ')/' + quantum + ')*' + quantum;
    },
    isNumberType: function (type) {
        return type in Runtime.INT_TYPES || type in Runtime.FLOAT_TYPES;
    },
    isPointerType: function isPointerType(type) {
        return type[type.length-1] == '*';
    },
    isStructType: function isStructType(type) {
        if (isPointerType(type)) return false;
        if (isArrayType(type)) return true;
        if (/<?\{ ?[^}]* ?\}>?/.test(type)) return true; // { i32, i8 } etc. - anonymous struct types
        // See comment in isStructPointerType()
        return type[0] == '%';
    },
    INT_TYPES: {"i1":0,"i8":0,"i16":0,"i32":0,"i64":0},
    FLOAT_TYPES: {"float":0,"double":0},
    or64: function (x, y) {
        var l = (x | 0) | (y | 0);
        var h = (Math.round(x / 4294967296) | Math.round(y / 4294967296)) * 4294967296;
        return l + h;
    },
    and64: function (x, y) {
        var l = (x | 0) & (y | 0);
        var h = (Math.round(x / 4294967296) & Math.round(y / 4294967296)) * 4294967296;
        return l + h;
    },
    xor64: function (x, y) {
        var l = (x | 0) ^ (y | 0);
        var h = (Math.round(x / 4294967296) ^ Math.round(y / 4294967296)) * 4294967296;
        return l + h;
    },
    getNativeTypeSize: function (type) {
        switch (type) {
            case 'i1': case 'i8': return 1;
            case 'i16': return 2;
            case 'i32': return 4;
            case 'i64': return 8;
            case 'float': return 4;
            case 'double': return 8;
            default: {
                if (type[type.length-1] === '*') {
                    return Runtime.QUANTUM_SIZE; // A pointer
                } else if (type[0] === 'i') {
                    var bits = parseInt(type.substr(1));
                    assert(bits % 8 === 0);
                    return bits/8;
                } else {
                    return 0;
                }
            }
        }
    },
    getNativeFieldSize: function (type) {
        return Math.max(Runtime.getNativeTypeSize(type), Runtime.QUANTUM_SIZE);
    },
    dedup: function dedup(items, ident) {
        var seen = {};
        if (ident) {
            return items.filter(function(item) {
                if (seen[item[ident]]) return false;
                seen[item[ident]] = true;
                return true;
            });
        } else {
            return items.filter(function(item) {
                if (seen[item]) return false;
                seen[item] = true;
                return true;
            });
        }
    },
    set: function set() {
        var args = typeof arguments[0] === 'object' ? arguments[0] : arguments;
        var ret = {};
        for (var i = 0; i < args.length; i++) {
            ret[args[i]] = 0;
        }
        return ret;
    },
    STACK_ALIGN: 8,
    getAlignSize: function (type, size, vararg) {
        // we align i64s and doubles on 64-bit boundaries, unlike x86
        if (!vararg && (type == 'i64' || type == 'double')) return 8;
        if (!type) return Math.min(size, 8); // align structures internally to 64 bits
        return Math.min(size || (type ? Runtime.getNativeFieldSize(type) : 0), Runtime.QUANTUM_SIZE);
    },
    calculateStructAlignment: function calculateStructAlignment(type) {
        type.flatSize = 0;
        type.alignSize = 0;
        var diffs = [];
        var prev = -1;
        var index = 0;
        type.flatIndexes = type.fields.map(function(field) {
            index++;
            var size, alignSize;
            if (Runtime.isNumberType(field) || Runtime.isPointerType(field)) {
                size = Runtime.getNativeTypeSize(field); // pack char; char; in structs, also char[X]s.
                alignSize = Runtime.getAlignSize(field, size);
            } else if (Runtime.isStructType(field)) {
                if (field[1] === '0') {
                    // this is [0 x something]. When inside another structure like here, it must be at the end,
                    // and it adds no size
                    // XXX this happens in java-nbody for example... assert(index === type.fields.length, 'zero-length in the middle!');
                    size = 0;
                    if (Types.types[field]) {
                        alignSize = Runtime.getAlignSize(null, Types.types[field].alignSize);
                    } else {
                        alignSize = type.alignSize || QUANTUM_SIZE;
                    }
                } else {
                    size = Types.types[field].flatSize;
                    alignSize = Runtime.getAlignSize(null, Types.types[field].alignSize);
                }
            } else if (field[0] == 'b') {
                // bN, large number field, like a [N x i8]
                size = field.substr(1)|0;
                alignSize = 1;
            } else if (field[0] === '<') {
                // vector type
                size = alignSize = Types.types[field].flatSize; // fully aligned
            } else if (field[0] === 'i') {
                // illegal integer field, that could not be legalized because it is an internal structure field
                // it is ok to have such fields, if we just use them as markers of field size and nothing more complex
                size = alignSize = parseInt(field.substr(1))/8;
                assert(size % 1 === 0, 'cannot handle non-byte-size field ' + field);
            } else {
                assert(false, 'invalid type for calculateStructAlignment');
            }
            if (type.packed) alignSize = 1;
            type.alignSize = Math.max(type.alignSize, alignSize);
            var curr = Runtime.alignMemory(type.flatSize, alignSize); // if necessary, place this on aligned memory
            type.flatSize = curr + size;
            if (prev >= 0) {
                diffs.push(curr-prev);
            }
            prev = curr;
            return curr;
        });
        if (type.name_ && type.name_[0] === '[') {
            // arrays have 2 elements, so we get the proper difference. then we scale here. that way we avoid
            // allocating a potentially huge array for [999999 x i8] etc.
            type.flatSize = parseInt(type.name_.substr(1))*type.flatSize/2;
        }
        type.flatSize = Runtime.alignMemory(type.flatSize, type.alignSize);
        if (diffs.length == 0) {
            type.flatFactor = type.flatSize;
        } else if (Runtime.dedup(diffs).length == 1) {
            type.flatFactor = diffs[0];
        }
        type.needsFlattening = (type.flatFactor != 1);
        return type.flatIndexes;
    },
    generateStructInfo: function (struct, typeName, offset) {
        var type, alignment;
        if (typeName) {
            offset = offset || 0;
            type = (typeof Types === 'undefined' ? Runtime.typeInfo : Types.types)[typeName];
            if (!type) return null;
            if (type.fields.length != struct.length) {
                printErr('Number of named fields must match the type for ' + typeName + ': possibly duplicate struct names. Cannot return structInfo');
                return null;
            }
            alignment = type.flatIndexes;
        } else {
            var type = { fields: struct.map(function(item) { return item[0] }) };
            alignment = Runtime.calculateStructAlignment(type);
        }
        var ret = {
            __size__: type.flatSize
        };
        if (typeName) {
            struct.forEach(function(item, i) {
                if (typeof item === 'string') {
                    ret[item] = alignment[i] + offset;
                } else {
                    // embedded struct
                    var key;
                    for (var k in item) key = k;
                    ret[key] = Runtime.generateStructInfo(item[key], type.fields[i], alignment[i]);
                }
            });
        } else {
            struct.forEach(function(item, i) {
                ret[item[1]] = alignment[i];
            });
        }
        return ret;
    },
    dynCall: function (sig, ptr, args) {
        if (args && args.length) {
            if (!args.splice) args = Array.prototype.slice.call(args);
            args.splice(0, 0, ptr);
            return Module['dynCall_' + sig].apply(null, args);
        } else {
            return Module['dynCall_' + sig].call(null, ptr);
        }
    },
    functionPointers: [],
    addFunction: function (func) {
        for (var i = 0; i < Runtime.functionPointers.length; i++) {
            if (!Runtime.functionPointers[i]) {
                Runtime.functionPointers[i] = func;
                return 2*(1 + i);
            }
        }
        throw 'Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.';
    },
    removeFunction: function (index) {
        Runtime.functionPointers[(index-2)/2] = null;
    },
    getAsmConst: function (code, numArgs) {
        // code is a constant string on the heap, so we can cache these
        if (!Runtime.asmConstCache) Runtime.asmConstCache = {};
        var func = Runtime.asmConstCache[code];
        if (func) return func;
        var args = [];
        for (var i = 0; i < numArgs; i++) {
            args.push(String.fromCharCode(36) + i); // $0, $1 etc
        }
        var source = Pointer_stringify(code);
        if (source[0] === '"') {
            // tolerate EM_ASM("..code..") even though EM_ASM(..code..) is correct
            if (source.indexOf('"', 1) === source.length-1) {
                source = source.substr(1, source.length-2);
            } else {
                // something invalid happened, e.g. EM_ASM("..code($0)..", input)
                abort('invalid EM_ASM input |' + source + '|. Please use EM_ASM(..code..) (no quotes) or EM_ASM({ ..code($0).. }, input) (to input values)');
            }
        }
        try {
            var evalled = eval('(function(' + args.join(',') + '){ ' + source + ' })'); // new Function does not allow upvars in node
        } catch(e) {
            Module.printErr('error in executing inline EM_ASM code: ' + e + ' on: \n\n' + source + '\n\nwith args |' + args + '| (make sure to use the right one out of EM_ASM, EM_ASM_ARGS, etc.)');
            throw e;
        }
        return Runtime.asmConstCache[code] = evalled;
    },
    warnOnce: function (text) {
        if (!Runtime.warnOnce.shown) Runtime.warnOnce.shown = {};
        if (!Runtime.warnOnce.shown[text]) {
            Runtime.warnOnce.shown[text] = 1;
            Module.printErr(text);
        }
    },
    funcWrappers: {},
    getFuncWrapper: function (func, sig) {
        assert(sig);
        if (!Runtime.funcWrappers[func]) {
            Runtime.funcWrappers[func] = function dynCall_wrapper() {
                return Runtime.dynCall(sig, func, arguments);
            };
        }
        return Runtime.funcWrappers[func];
    },
    UTF8Processor: function () {
        var buffer = [];
        var needed = 0;
        this.processCChar = function (code) {
            code = code & 0xFF;

            if (buffer.length == 0) {
                if ((code & 0x80) == 0x00) {        // 0xxxxxxx
                    return String.fromCharCode(code);
                }
                buffer.push(code);
                if ((code & 0xE0) == 0xC0) {        // 110xxxxx
                    needed = 1;
                } else if ((code & 0xF0) == 0xE0) { // 1110xxxx
                    needed = 2;
                } else {                            // 11110xxx
                    needed = 3;
                }
                return '';
            }

            if (needed) {
                buffer.push(code);
                needed--;
                if (needed > 0) return '';
            }

            var c1 = buffer[0];
            var c2 = buffer[1];
            var c3 = buffer[2];
            var c4 = buffer[3];
            var ret;
            if (buffer.length == 2) {
                ret = String.fromCharCode(((c1 & 0x1F) << 6)  | (c2 & 0x3F));
            } else if (buffer.length == 3) {
                ret = String.fromCharCode(((c1 & 0x0F) << 12) | ((c2 & 0x3F) << 6)  | (c3 & 0x3F));
            } else {
                // http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
                var codePoint = ((c1 & 0x07) << 18) | ((c2 & 0x3F) << 12) |
                    ((c3 & 0x3F) << 6)  | (c4 & 0x3F);
                ret = String.fromCharCode(
                    Math.floor((codePoint - 0x10000) / 0x400) + 0xD800,
                    (codePoint - 0x10000) % 0x400 + 0xDC00);
            }
            buffer.length = 0;
            return ret;
        }
        this.processJSString = function processJSString(string) {
            /* TODO: use TextEncoder when present,
        var encoder = new TextEncoder();
        encoder['encoding'] = "utf-8";
        var utf8Array = encoder['encode'](aMsg.data);
      */
            string = unescape(encodeURIComponent(string));
            var ret = [];
            for (var i = 0; i < string.length; i++) {
                ret.push(string.charCodeAt(i));
            }
            return ret;
        }
    },
    getCompilerSetting: function (name) {
        throw 'You must build with -s RETAIN_COMPILER_SETTINGS=1 for Runtime.getCompilerSetting or emscripten_get_compiler_setting to work';
    },
    stackAlloc: function (size) { var ret = STACKTOP;STACKTOP = (STACKTOP + size)|0;STACKTOP = (((STACKTOP)+7)&-8); return ret; },
    staticAlloc: function (size) { var ret = STATICTOP;STATICTOP = (STATICTOP + size)|0;STATICTOP = (((STATICTOP)+7)&-8); return ret; },
    dynamicAlloc: function (size) { var ret = DYNAMICTOP;DYNAMICTOP = (DYNAMICTOP + size)|0;DYNAMICTOP = (((DYNAMICTOP)+7)&-8); if (DYNAMICTOP >= TOTAL_MEMORY) enlargeMemory();; return ret; },
    alignMemory: function (size,quantum) { var ret = size = Math.ceil((size)/(quantum ? quantum : 8))*(quantum ? quantum : 8); return ret; },
    makeBigInt: function (low,high,unsigned) { var ret = (unsigned ? ((+((low>>>0)))+((+((high>>>0)))*(+4294967296))) : ((+((low>>>0)))+((+((high|0)))*(+4294967296)))); return ret; },
    GLOBAL_BASE: 8,
    QUANTUM_SIZE: 4,
    __dummy__: 0
}


Module['Runtime'] = Runtime;









//========================================
// Runtime essentials
//========================================

var __THREW__ = 0; // Used in checking for thrown exceptions.

var ABORT = false; // whether we are quitting the application. no code should run after this. set in exit() and abort()
var EXITSTATUS = 0;

var undef = 0;
// tempInt is used for 32-bit signed values or smaller. tempBigInt is used
// for 32-bit unsigned values or more than 32 bits. TODO: audit all uses of tempInt
var tempValue, tempInt, tempBigInt, tempInt2, tempBigInt2, tempPair, tempBigIntI, tempBigIntR, tempBigIntS, tempBigIntP, tempBigIntD, tempDouble, tempFloat;
var tempI64, tempI64b;
var tempRet0, tempRet1, tempRet2, tempRet3, tempRet4, tempRet5, tempRet6, tempRet7, tempRet8, tempRet9;

function assert(condition, text) {
    if (!condition) {
        abort('Assertion failed: ' + text);
    }
}

var globalScope = this;

// C calling interface. A convenient way to call C functions (in C files, or
// defined with extern "C").
//
// Note: LLVM optimizations can inline and remove functions, after which you will not be
//       able to call them. Closure can also do so. To avoid that, add your function to
//       the exports using something like
//
//         -s EXPORTED_FUNCTIONS='["_main", "_myfunc"]'
//
// @param ident      The name of the C function (note that C++ functions will be name-mangled - use extern "C")
// @param returnType The return type of the function, one of the JS types 'number', 'string' or 'array' (use 'number' for any C pointer, and
//                   'array' for JavaScript arrays and typed arrays; note that arrays are 8-bit).
// @param argTypes   An array of the types of arguments for the function (if there are no arguments, this can be ommitted). Types are as in returnType,
//                   except that 'array' is not possible (there is no way for us to know the length of the array)
// @param args       An array of the arguments to the function, as native JS values (as in returnType)
//                   Note that string arguments will be stored on the stack (the JS string will become a C string on the stack).
// @return           The return value, as a native JS value (as in returnType)
function ccall(ident, returnType, argTypes, args) {
    return ccallFunc(getCFunc(ident), returnType, argTypes, args);
}
Module["ccall"] = ccall;

// Returns the C function with a specified identifier (for C++, you need to do manual name mangling)
function getCFunc(ident) {
    try {
        var func = Module['_' + ident]; // closure exported function
        if (!func) func = eval('_' + ident); // explicit lookup
    } catch(e) {
    }
    assert(func, 'Cannot call unknown function ' + ident + ' (perhaps LLVM optimizations or closure removed it?)');
    return func;
}

// Internal function that does a C call using a function, not an identifier
function ccallFunc(func, returnType, argTypes, args) {
    var stack = 0;
    function toC(value, type) {
        if (type == 'string') {
            if (value === null || value === undefined || value === 0) return 0; // null string
            value = intArrayFromString(value);
            type = 'array';
        }
        if (type == 'array') {
            if (!stack) stack = Runtime.stackSave();
            var ret = Runtime.stackAlloc(value.length);
            writeArrayToMemory(value, ret);
            return ret;
        }
        return value;
    }
    function fromC(value, type) {
        if (type == 'string') {
            return Pointer_stringify(value);
        }
        assert(type != 'array');
        return value;
    }
    var i = 0;
    var cArgs = args ? args.map(function(arg) {
        return toC(arg, argTypes[i++]);
    }) : [];
    var ret = fromC(func.apply(null, cArgs), returnType);
    if (stack) Runtime.stackRestore(stack);
    return ret;
}

// Returns a native JS wrapper for a C function. This is similar to ccall, but
// returns a function you can call repeatedly in a normal way. For example:
//
//   var my_function = cwrap('my_c_function', 'number', ['number', 'number']);
//   alert(my_function(5, 22));
//   alert(my_function(99, 12));
//
function cwrap(ident, returnType, argTypes) {
    var func = getCFunc(ident);
    return function() {
        return ccallFunc(func, returnType, argTypes, Array.prototype.slice.call(arguments));
    }
}
Module["cwrap"] = cwrap;

// Sets a value in memory in a dynamic way at run-time. Uses the
// type data. This is the same as makeSetValue, except that
// makeSetValue is done at compile-time and generates the needed
// code then, whereas this function picks the right code at
// run-time.
// Note that setValue and getValue only do *aligned* writes and reads!
// Note that ccall uses JS types as for defining types, while setValue and
// getValue need LLVM types ('i8', 'i32') - this is a lower-level operation
function setValue(ptr, value, type, noSafe) {
    type = type || 'i8';
    if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
        case 'i1': HEAP8[(ptr)]=value; break;
        case 'i8': HEAP8[(ptr)]=value; break;
        case 'i16': HEAP16[((ptr)>>1)]=value; break;
        case 'i32': HEAP32[((ptr)>>2)]=value; break;
        case 'i64': (tempI64 = [value>>>0,(tempDouble=value,(+(Math_abs(tempDouble))) >= (+1) ? (tempDouble > (+0) ? ((Math_min((+(Math_floor((tempDouble)/(+4294967296)))), (+4294967295)))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/(+4294967296))))))>>>0) : 0)],HEAP32[((ptr)>>2)]=tempI64[0],HEAP32[(((ptr)+(4))>>2)]=tempI64[1]); break;
        case 'float': HEAPF32[((ptr)>>2)]=value; break;
        case 'double': HEAPF64[((ptr)>>3)]=value; break;
        default: abort('invalid type for setValue: ' + type);
    }
}
Module['setValue'] = setValue;

// Parallel to setValue.
function getValue(ptr, type, noSafe) {
    type = type || 'i8';
    if (type.charAt(type.length-1) === '*') type = 'i32'; // pointers are 32-bit
    switch(type) {
        case 'i1': return HEAP8[(ptr)];
        case 'i8': return HEAP8[(ptr)];
        case 'i16': return HEAP16[((ptr)>>1)];
        case 'i32': return HEAP32[((ptr)>>2)];
        case 'i64': return HEAP32[((ptr)>>2)];
        case 'float': return HEAPF32[((ptr)>>2)];
        case 'double': return HEAPF64[((ptr)>>3)];
        default: abort('invalid type for setValue: ' + type);
    }
    return null;
}
Module['getValue'] = getValue;

var ALLOC_NORMAL = 0; // Tries to use _malloc()
var ALLOC_STACK = 1; // Lives for the duration of the current function call
var ALLOC_STATIC = 2; // Cannot be freed
var ALLOC_DYNAMIC = 3; // Cannot be freed except through sbrk
var ALLOC_NONE = 4; // Do not allocate
Module['ALLOC_NORMAL'] = ALLOC_NORMAL;
Module['ALLOC_STACK'] = ALLOC_STACK;
Module['ALLOC_STATIC'] = ALLOC_STATIC;
Module['ALLOC_DYNAMIC'] = ALLOC_DYNAMIC;
Module['ALLOC_NONE'] = ALLOC_NONE;

// allocate(): This is for internal use. You can use it yourself as well, but the interface
//             is a little tricky (see docs right below). The reason is that it is optimized
//             for multiple syntaxes to save space in generated code. So you should
//             normally not use allocate(), and instead allocate memory using _malloc(),
//             initialize it with setValue(), and so forth.
// @slab: An array of data, or a number. If a number, then the size of the block to allocate,
//        in *bytes* (note that this is sometimes confusing: the next parameter does not
//        affect this!)
// @types: Either an array of types, one for each byte (or 0 if no type at that position),
//         or a single type which is used for the entire block. This only matters if there
//         is initial data - if @slab is a number, then this does not matter at all and is
//         ignored.
// @allocator: How to allocate memory, see ALLOC_*
function allocate(slab, types, allocator, ptr) {
    var zeroinit, size;
    if (typeof slab === 'number') {
        zeroinit = true;
        size = slab;
    } else {
        zeroinit = false;
        size = slab.length;
    }

    var singleType = typeof types === 'string' ? types : null;

    var ret;
    if (allocator == ALLOC_NONE) {
        ret = ptr;
    } else {
        ret = [_malloc, Runtime.stackAlloc, Runtime.staticAlloc, Runtime.dynamicAlloc][allocator === undefined ? ALLOC_STATIC : allocator](Math.max(size, singleType ? 1 : types.length));
    }

    if (zeroinit) {
        var ptr = ret, stop;
        assert((ret & 3) == 0);
        stop = ret + (size & ~3);
        for (; ptr < stop; ptr += 4) {
            HEAP32[((ptr)>>2)]=0;
        }
        stop = ret + size;
        while (ptr < stop) {
            HEAP8[((ptr++)|0)]=0;
        }
        return ret;
    }

    if (singleType === 'i8') {
        if (slab.subarray || slab.slice) {
            HEAPU8.set(slab, ret);
        } else {
            HEAPU8.set(new Uint8Array(slab), ret);
        }
        return ret;
    }

    var i = 0, type, typeSize, previousType;
    while (i < size) {
        var curr = slab[i];

        if (typeof curr === 'function') {
            curr = Runtime.getFunctionIndex(curr);
        }

        type = singleType || types[i];
        if (type === 0) {
            i++;
            continue;
        }

        if (type == 'i64') type = 'i32'; // special case: we have one i32 here, and one i32 later

        setValue(ret+i, curr, type);

        // no need to look up size unless type changes, so cache it
        if (previousType !== type) {
            typeSize = Runtime.getNativeTypeSize(type);
            previousType = type;
        }
        i += typeSize;
    }

    return ret;
}
Module['allocate'] = allocate;

function Pointer_stringify(ptr, /* optional */ length) {
    // TODO: use TextDecoder
    // Find the length, and check for UTF while doing so
    var hasUtf = false;
    var t;
    var i = 0;
    while (1) {
        t = HEAPU8[(((ptr)+(i))|0)];
        if (t >= 128) hasUtf = true;
        else if (t == 0 && !length) break;
        i++;
        if (length && i == length) break;
    }
    if (!length) length = i;

    var ret = '';

    if (!hasUtf) {
        var MAX_CHUNK = 1024; // split up into chunks, because .apply on a huge string can overflow the stack
        var curr;
        while (length > 0) {
            curr = String.fromCharCode.apply(String, HEAPU8.subarray(ptr, ptr + Math.min(length, MAX_CHUNK)));
            ret = ret ? ret + curr : curr;
            ptr += MAX_CHUNK;
            length -= MAX_CHUNK;
        }
        return ret;
    }

    var utf8 = new Runtime.UTF8Processor();
    for (i = 0; i < length; i++) {
        t = HEAPU8[(((ptr)+(i))|0)];
        ret += utf8.processCChar(t);
    }
    return ret;
}
Module['Pointer_stringify'] = Pointer_stringify;

// Given a pointer 'ptr' to a null-terminated UTF16LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.
function UTF16ToString(ptr) {
    var i = 0;

    var str = '';
    while (1) {
        var codeUnit = HEAP16[(((ptr)+(i*2))>>1)];
        if (codeUnit == 0)
            return str;
        ++i;
        // fromCharCode constructs a character from a UTF-16 code unit, so we can pass the UTF16 string right through.
        str += String.fromCharCode(codeUnit);
    }
}
Module['UTF16ToString'] = UTF16ToString;

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF16LE form. The copy will require at most (str.length*2+1)*2 bytes of space in the HEAP.
function stringToUTF16(str, outPtr) {
    for(var i = 0; i < str.length; ++i) {
        // charCodeAt returns a UTF-16 encoded code unit, so it can be directly written to the HEAP.
        var codeUnit = str.charCodeAt(i); // possibly a lead surrogate
        HEAP16[(((outPtr)+(i*2))>>1)]=codeUnit;
    }
    // Null-terminate the pointer to the HEAP.
    HEAP16[(((outPtr)+(str.length*2))>>1)]=0;
}
Module['stringToUTF16'] = stringToUTF16;

// Given a pointer 'ptr' to a null-terminated UTF32LE-encoded string in the emscripten HEAP, returns
// a copy of that string as a Javascript String object.
function UTF32ToString(ptr) {
    var i = 0;

    var str = '';
    while (1) {
        var utf32 = HEAP32[(((ptr)+(i*4))>>2)];
        if (utf32 == 0)
            return str;
        ++i;
        // Gotcha: fromCharCode constructs a character from a UTF-16 encoded code (pair), not from a Unicode code point! So encode the code point to UTF-16 for constructing.
        if (utf32 >= 0x10000) {
            var ch = utf32 - 0x10000;
            str += String.fromCharCode(0xD800 | (ch >> 10), 0xDC00 | (ch & 0x3FF));
        } else {
            str += String.fromCharCode(utf32);
        }
    }
}
Module['UTF32ToString'] = UTF32ToString;

// Copies the given Javascript String object 'str' to the emscripten HEAP at address 'outPtr',
// null-terminated and encoded in UTF32LE form. The copy will require at most (str.length+1)*4 bytes of space in the HEAP,
// but can use less, since str.length does not return the number of characters in the string, but the number of UTF-16 code units in the string.
function stringToUTF32(str, outPtr) {
    var iChar = 0;
    for(var iCodeUnit = 0; iCodeUnit < str.length; ++iCodeUnit) {
        // Gotcha: charCodeAt returns a 16-bit word that is a UTF-16 encoded code unit, not a Unicode code point of the character! We must decode the string to UTF-32 to the heap.
        var codeUnit = str.charCodeAt(iCodeUnit); // possibly a lead surrogate
        if (codeUnit >= 0xD800 && codeUnit <= 0xDFFF) {
            var trailSurrogate = str.charCodeAt(++iCodeUnit);
            codeUnit = 0x10000 + ((codeUnit & 0x3FF) << 10) | (trailSurrogate & 0x3FF);
        }
        HEAP32[(((outPtr)+(iChar*4))>>2)]=codeUnit;
        ++iChar;
    }
    // Null-terminate the pointer to the HEAP.
    HEAP32[(((outPtr)+(iChar*4))>>2)]=0;
}
Module['stringToUTF32'] = stringToUTF32;

function demangle(func) {
    var i = 3;
    // params, etc.
    var basicTypes = {
        'v': 'void',
        'b': 'bool',
        'c': 'char',
        's': 'short',
        'i': 'int',
        'l': 'long',
        'f': 'float',
        'd': 'double',
        'w': 'wchar_t',
        'a': 'signed char',
        'h': 'unsigned char',
        't': 'unsigned short',
        'j': 'unsigned int',
        'm': 'unsigned long',
        'x': 'long long',
        'y': 'unsigned long long',
        'z': '...'
    };
    var subs = [];
    var first = true;
    function dump(x) {
        //return;
        if (x) Module.print(x);
        Module.print(func);
        var pre = '';
        for (var a = 0; a < i; a++) pre += ' ';
        Module.print (pre + '^');
    }
    function parseNested() {
        i++;
        if (func[i] === 'K') i++; // ignore const
        var parts = [];
        while (func[i] !== 'E') {
            if (func[i] === 'S') { // substitution
                i++;
                var next = func.indexOf('_', i);
                var num = func.substring(i, next) || 0;
                parts.push(subs[num] || '?');
                i = next+1;
                continue;
            }
            if (func[i] === 'C') { // constructor
                parts.push(parts[parts.length-1]);
                i += 2;
                continue;
            }
            var size = parseInt(func.substr(i));
            var pre = size.toString().length;
            if (!size || !pre) { i--; break; } // counter i++ below us
            var curr = func.substr(i + pre, size);
            parts.push(curr);
            subs.push(curr);
            i += pre + size;
        }
        i++; // skip E
        return parts;
    }
    function parse(rawList, limit, allowVoid) { // main parser
        limit = limit || Infinity;
        var ret = '', list = [];
        function flushList() {
            return '(' + list.join(', ') + ')';
        }
        var name;
        if (func[i] === 'N') {
            // namespaced N-E
            name = parseNested().join('::');
            limit--;
            if (limit === 0) return rawList ? [name] : name;
        } else {
            // not namespaced
            if (func[i] === 'K' || (first && func[i] === 'L')) i++; // ignore const and first 'L'
            var size = parseInt(func.substr(i));
            if (size) {
                var pre = size.toString().length;
                name = func.substr(i + pre, size);
                i += pre + size;
            }
        }
        first = false;
        if (func[i] === 'I') {
            i++;
            var iList = parse(true);
            var iRet = parse(true, 1, true);
            ret += iRet[0] + ' ' + name + '<' + iList.join(', ') + '>';
        } else {
            ret = name;
        }
        paramLoop: while (i < func.length && limit-- > 0) {
            //dump('paramLoop');
            var c = func[i++];
            if (c in basicTypes) {
                list.push(basicTypes[c]);
            } else {
                switch (c) {
                    case 'P': list.push(parse(true, 1, true)[0] + '*'); break; // pointer
                    case 'R': list.push(parse(true, 1, true)[0] + '&'); break; // reference
                    case 'L': { // literal
                        i++; // skip basic type
                        var end = func.indexOf('E', i);
                        var size = end - i;
                        list.push(func.substr(i, size));
                        i += size + 2; // size + 'EE'
                        break;
                    }
                    case 'A': { // array
                        var size = parseInt(func.substr(i));
                        i += size.toString().length;
                        if (func[i] !== '_') throw '?';
                        i++; // skip _
                        list.push(parse(true, 1, true)[0] + ' [' + size + ']');
                        break;
                    }
                    case 'E': break paramLoop;
                    default: ret += '?' + c; break paramLoop;
                }
            }
        }
        if (!allowVoid && list.length === 1 && list[0] === 'void') list = []; // avoid (void)
        if (rawList) {
            if (ret) {
                list.push(ret + '?');
            }
            return list;
        } else {
            return ret + flushList();
        }
    }
    try {
        // Special-case the entry point, since its name differs from other name mangling.
        if (func == 'Object._main' || func == '_main') {
            return 'main()';
        }
        if (typeof func === 'number') func = Pointer_stringify(func);
        if (func[0] !== '_') return func;
        if (func[1] !== '_') return func; // C function
        if (func[2] !== 'Z') return func;
        switch (func[3]) {
            case 'n': return 'operator new()';
            case 'd': return 'operator delete()';
        }
        return parse();
    } catch(e) {
        return func;
    }
}

function demangleAll(text) {
    return text.replace(/__Z[\w\d_]+/g, function(x) { var y = demangle(x); return x === y ? x : (x + ' [' + y + ']') });
}

function stackTrace() {
    var stack = new Error().stack;
    return stack ? demangleAll(stack) : '(no stack trace available)'; // Stack trace is not available at least on IE10 and Safari 6.
}

// Memory management

var PAGE_SIZE = 4096;
function alignMemoryPage(x) {
    return (x+4095)&-4096;
}

var HEAP;
var HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

var STATIC_BASE = 0, STATICTOP = 0, staticSealed = false; // static area
var STACK_BASE = 0, STACKTOP = 0, STACK_MAX = 0; // stack area
var DYNAMIC_BASE = 0, DYNAMICTOP = 0; // dynamic area handled by sbrk

function enlargeMemory() {
    abort('Cannot enlarge memory arrays. Either (1) compile with -s TOTAL_MEMORY=X with X higher than the current value ' + TOTAL_MEMORY + ', (2) compile with ALLOW_MEMORY_GROWTH which adjusts the size at runtime but prevents some optimizations, or (3) set Module.TOTAL_MEMORY before the program runs.');
}

var TOTAL_STACK = Module['TOTAL_STACK'] || 5242880;
var TOTAL_MEMORY = Module['TOTAL_MEMORY'] || 16777216;
var FAST_MEMORY = Module['FAST_MEMORY'] || 2097152;

var totalMemory = 4096;
while (totalMemory < TOTAL_MEMORY || totalMemory < 2*TOTAL_STACK) {
    if (totalMemory < 16*1024*1024) {
        totalMemory *= 2;
    } else {
        totalMemory += 16*1024*1024
    }
}
if (totalMemory !== TOTAL_MEMORY) {
    Module.printErr('increasing TOTAL_MEMORY to ' + totalMemory + ' to be more reasonable');
    TOTAL_MEMORY = totalMemory;
}

// Initialize the runtime's memory
// check for full engine support (use string 'subarray' to avoid closure compiler confusion)
assert(typeof Int32Array !== 'undefined' && typeof Float64Array !== 'undefined' && !!(new Int32Array(1)['subarray']) && !!(new Int32Array(1)['set']),
    'JS engine does not provide full typed array support');

var buffer = new ArrayBuffer(TOTAL_MEMORY);
HEAP8 = new Int8Array(buffer);
HEAP16 = new Int16Array(buffer);
HEAP32 = new Int32Array(buffer);
HEAPU8 = new Uint8Array(buffer);
HEAPU16 = new Uint16Array(buffer);
HEAPU32 = new Uint32Array(buffer);
HEAPF32 = new Float32Array(buffer);
HEAPF64 = new Float64Array(buffer);

// Endianness check (note: assumes compiler arch was little-endian)
HEAP32[0] = 255;
assert(HEAPU8[0] === 255 && HEAPU8[3] === 0, 'Typed arrays 2 must be run on a little-endian system');

Module['HEAP'] = HEAP;
Module['HEAP8'] = HEAP8;
Module['HEAP16'] = HEAP16;
Module['HEAP32'] = HEAP32;
Module['HEAPU8'] = HEAPU8;
Module['HEAPU16'] = HEAPU16;
Module['HEAPU32'] = HEAPU32;
Module['HEAPF32'] = HEAPF32;
Module['HEAPF64'] = HEAPF64;

function callRuntimeCallbacks(callbacks) {
    while(callbacks.length > 0) {
        var callback = callbacks.shift();
        if (typeof callback == 'function') {
            callback();
            continue;
        }
        var func = callback.func;
        if (typeof func === 'number') {
            if (callback.arg === undefined) {
                Runtime.dynCall('v', func);
            } else {
                Runtime.dynCall('vi', func, [callback.arg]);
            }
        } else {
            func(callback.arg === undefined ? null : callback.arg);
        }
    }
}

var __ATPRERUN__  = []; // functions called before the runtime is initialized
var __ATINIT__    = []; // functions called during startup
var __ATMAIN__    = []; // functions called when main() is to be run
var __ATEXIT__    = []; // functions called during shutdown
var __ATPOSTRUN__ = []; // functions called after the runtime has exited

var runtimeInitialized = false;

function preRun() {
    // compatibility - merge in anything from Module['preRun'] at this time
    if (Module['preRun']) {
        if (typeof Module['preRun'] == 'function') Module['preRun'] = [Module['preRun']];
        while (Module['preRun'].length) {
            addOnPreRun(Module['preRun'].shift());
        }
    }
    callRuntimeCallbacks(__ATPRERUN__);
}

function ensureInitRuntime() {
    if (runtimeInitialized) return;
    runtimeInitialized = true;
    callRuntimeCallbacks(__ATINIT__);
}

function preMain() {
    callRuntimeCallbacks(__ATMAIN__);
}

function exitRuntime() {
    callRuntimeCallbacks(__ATEXIT__);
}

function postRun() {
    // compatibility - merge in anything from Module['postRun'] at this time
    if (Module['postRun']) {
        if (typeof Module['postRun'] == 'function') Module['postRun'] = [Module['postRun']];
        while (Module['postRun'].length) {
            addOnPostRun(Module['postRun'].shift());
        }
    }
    callRuntimeCallbacks(__ATPOSTRUN__);
}

function addOnPreRun(cb) {
    __ATPRERUN__.unshift(cb);
}
Module['addOnPreRun'] = Module.addOnPreRun = addOnPreRun;

function addOnInit(cb) {
    __ATINIT__.unshift(cb);
}
Module['addOnInit'] = Module.addOnInit = addOnInit;

function addOnPreMain(cb) {
    __ATMAIN__.unshift(cb);
}
Module['addOnPreMain'] = Module.addOnPreMain = addOnPreMain;

function addOnExit(cb) {
    __ATEXIT__.unshift(cb);
}
Module['addOnExit'] = Module.addOnExit = addOnExit;

function addOnPostRun(cb) {
    __ATPOSTRUN__.unshift(cb);
}
Module['addOnPostRun'] = Module.addOnPostRun = addOnPostRun;

// Tools

// This processes a JS string into a C-line array of numbers, 0-terminated.
// For LLVM-originating strings, see parser.js:parseLLVMString function
function intArrayFromString(stringy, dontAddNull, length /* optional */) {
    var ret = (new Runtime.UTF8Processor()).processJSString(stringy);
    if (length) {
        ret.length = length;
    }
    if (!dontAddNull) {
        ret.push(0);
    }
    return ret;
}
Module['intArrayFromString'] = intArrayFromString;

function intArrayToString(array) {
    var ret = [];
    for (var i = 0; i < array.length; i++) {
        var chr = array[i];
        if (chr > 0xFF) {
            chr &= 0xFF;
        }
        ret.push(String.fromCharCode(chr));
    }
    return ret.join('');
}
Module['intArrayToString'] = intArrayToString;

// Write a Javascript array to somewhere in the heap
function writeStringToMemory(string, buffer, dontAddNull) {
    var array = intArrayFromString(string, dontAddNull);
    var i = 0;
    while (i < array.length) {
        var chr = array[i];
        HEAP8[(((buffer)+(i))|0)]=chr;
        i = i + 1;
    }
}
Module['writeStringToMemory'] = writeStringToMemory;

function writeArrayToMemory(array, buffer) {
    for (var i = 0; i < array.length; i++) {
        HEAP8[(((buffer)+(i))|0)]=array[i];
    }
}
Module['writeArrayToMemory'] = writeArrayToMemory;

function writeAsciiToMemory(str, buffer, dontAddNull) {
    for (var i = 0; i < str.length; i++) {
        HEAP8[(((buffer)+(i))|0)]=str.charCodeAt(i);
    }
    if (!dontAddNull) HEAP8[(((buffer)+(str.length))|0)]=0;
}
Module['writeAsciiToMemory'] = writeAsciiToMemory;

function unSign(value, bits, ignore) {
    if (value >= 0) {
        return value;
    }
    return bits <= 32 ? 2*Math.abs(1 << (bits-1)) + value // Need some trickery, since if bits == 32, we are right at the limit of the bits JS uses in bitshifts
        : Math.pow(2, bits)         + value;
}
function reSign(value, bits, ignore) {
    if (value <= 0) {
        return value;
    }
    var half = bits <= 32 ? Math.abs(1 << (bits-1)) // abs is needed if bits == 32
        : Math.pow(2, bits-1);
    if (value >= half && (bits <= 32 || value > half)) { // for huge values, we can hit the precision limit and always get true here. so don't do that
        // but, in general there is no perfect solution here. With 64-bit ints, we get rounding and errors
        // TODO: In i64 mode 1, resign the two parts separately and safely
        value = -2*half + value; // Cannot bitshift half, as it may be at the limit of the bits JS uses in bitshifts
    }
    return value;
}

// check for imul support, and also for correctness ( https://bugs.webkit.org/show_bug.cgi?id=126345 )
if (!Math['imul'] || Math['imul'](0xffffffff, 5) !== -5) Math['imul'] = function imul(a, b) {
    var ah  = a >>> 16;
    var al = a & 0xffff;
    var bh  = b >>> 16;
    var bl = b & 0xffff;
    return (al*bl + ((ah*bl + al*bh) << 16))|0;
};
Math.imul = Math['imul'];


var Math_abs = Math.abs;
var Math_cos = Math.cos;
var Math_sin = Math.sin;
var Math_tan = Math.tan;
var Math_acos = Math.acos;
var Math_asin = Math.asin;
var Math_atan = Math.atan;
var Math_atan2 = Math.atan2;
var Math_exp = Math.exp;
var Math_log = Math.log;
var Math_sqrt = Math.sqrt;
var Math_ceil = Math.ceil;
var Math_floor = Math.floor;
var Math_pow = Math.pow;
var Math_imul = Math.imul;
var Math_fround = Math.fround;
var Math_min = Math.min;

// A counter of dependencies for calling run(). If we need to
// do asynchronous work before running, increment this and
// decrement it. Incrementing must happen in a place like
// PRE_RUN_ADDITIONS (used by emcc to add file preloading).
// Note that you can add dependencies in preRun, even though
// it happens right before run - run will be postponed until
// the dependencies are met.
var runDependencies = 0;
var runDependencyWatcher = null;
var dependenciesFulfilled = null; // overridden to take different actions when all run dependencies are fulfilled

function addRunDependency(id) {
    runDependencies++;
    if (Module['monitorRunDependencies']) {
        Module['monitorRunDependencies'](runDependencies);
    }
}
Module['addRunDependency'] = addRunDependency;
function removeRunDependency(id) {
    runDependencies--;
    if (Module['monitorRunDependencies']) {
        Module['monitorRunDependencies'](runDependencies);
    }
    if (runDependencies == 0) {
        if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null;
        }
        if (dependenciesFulfilled) {
            var callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback(); // can add another dependenciesFulfilled
        }
    }
}
Module['removeRunDependency'] = removeRunDependency;

Module["preloadedImages"] = {}; // maps url to image data
Module["preloadedAudios"] = {}; // maps url to audio data


var memoryInitializer = null;

// === Body ===





STATIC_BASE = 8;

STATICTOP = STATIC_BASE + Runtime.alignMemory(4987);
/* global initializers */ __ATINIT__.push();


/* memory initializer */ allocate([100,114,97,119,105,110,103,46,99,0,0,0,0,0,0,0,100,114,45,62,109,101,0,0,115,116,97,116,117,115,95,98,97,114,0,0,0,0,0,0,112,117,122,122,108,101,32,102,97,116,97,108,32,101,114,114,111,114,58,32,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,66,97,99,107,115,112,97,99,101,0,0,0,0,0,0,0,68,101,108,0,0,0,0,0,69,110,116,101,114,0,0,0,76,101,102,116,0,0,0,0,85,112,0,0,0,0,0,0,82,105,103,104,116,0,0,0,68,111,119,110,0,0,0,0,69,110,100,0,0,0,0,0,80,97,103,101,68,111,119,110,0,0,0,0,0,0,0,0,72,111,109,101,0,0,0,0,80,97,103,101,85,112,0,0,1,0,0,0,1,0,0,0,2,0,0,0,1,0,0,0,3,0,0,0,2,0,0,0,3,0,0,0,1,0,0,0,2,0,0,0,3,0,0,0,1,0,0,0,1,0,0,0,2,0,0,0,1,0,0,0,2,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,48,32,38,38,32,34,66,97,100,32,116,121,112,101,32,102,111,114,32,114,101,116,117,114,110,95,115,118,97,108,34,0,101,109,99,99,46,99,0,0,100,108,103,95,114,101,116,117,114,110,95,115,118,97,108,0,48,32,38,38,32,34,66,97,100,32,116,121,112,101,32,102,111,114,32,114,101,116,117,114,110,95,105,118,97,108,34,0,100,108,103,95,114,101,116,117,114,110,95,105,118,97,108,0,0,0,0,0,0,0,0,0,105,32,60,32,110,112,114,101,115,101,116,115,0,0,0,0,99,111,109,109,97,110,100,0,99,116,120,46,112,111,115,32,61,61,32,115,105,122,101,0,103,101,116,95,115,97,118,101,95,102,105,108,101,0,0,0,67,117,115,116,111,109,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,35,37,48,50,120,37,48,50,120,37,48,50,120,0,0,0,0,0,0,0,0,0,0,0,37,100,112,120,32,37,115,0,109,111,110,111,115,112,97,99,101,0,0,0,0,0,0,0,115,97,110,115,45,115,101,114,105,102,0,0,0,0,0,0,73,110,101,114,116,105,97,0,103,97,109,101,115,46,105,110,101,114,116,105,97,0,0,0,105,110,101,114,116,105,97,0,80,2,0,0,88,2,0,0,104,2,0,0,1,0,0,0,3,0,0,0,0,0,0,0,3,0,0,0,1,0,0,0,4,0,0,0,1,0,0,0,1,0,0,0,2,0,0,0,3,0,0,0,2,0,0,0,1,0,0,0,3,0,0,0,4,0,0,0,4,0,0,0,5,0,0,0,1,0,0,0,2,0,0,0,1,0,0,0,5,0,0,0,6,0,0,0,7,0,0,0,6,0,0,0,8,0,0,0,4,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0,4,0,0,0,32,0,0,0,3,0,0,0,4,0,0,0,5,0,0,0,6,0,0,0,5,0,0,0,1,0,0,0,1,0,0,0,2,0,0,0,9,0,0,0,0,0,0,0,2,0,0,0,3,0,0,0,1,0,0,0,7,0,0,0,0,0,0,0,100,115,45,62,112,108,97,121,101,114,95,98,97,99,107,103,114,111,117,110,100,0,0,0,105,110,101,114,116,105,97,46,99,0,0,0,0,0,0,0,103,97,109,101,95,114,101,100,114,97,119,0,0,0,0,0,68,69,65,68,33,0,0,0,65,117,116,111,45,115,111,108,118,101,114,32,117,115,101,100,46,32,0,0,0,0,0,0,71,101,109,115,58,32,37,100,0,0,0,0,0,0,0,0,65,117,116,111,45,115,111,108,118,101,100,46,0,0,0,0,67,79,77,80,76,69,84,69,68,33,0,0,0,0,0,0,100,101,97,116,104,115,32,62,32,48,0,0,0,0,0,0,32,32,32,68,101,97,116,104,115,58,32,37,100,0,0,0,33,100,115,45,62,112,108,97,121,101,114,95,98,103,95,115,97,118,101,100,0,0,0,0,33,100,115,45,62,112,108,97,121,101,114,95,98,97,99,107,103,114,111,117,110,100,0,0,103,97,109,101,95,115,101,116,95,115,105,122,101,0,0,0,114,101,116,45,62,115,111,108,110,112,111,115,32,60,32,114,101,116,45,62,115,111,108,110,45,62,108,101,110,0,0,0,101,120,101,99,117,116,101,95,109,111,118,101,0,0,0,0,33,114,101,116,45,62,100,101,97,100,0,0,0,0,0,0,114,101,116,45,62,115,111,108,110,45,62,114,101,102,99,111,117,110,116,32,62,32,48,0,100,105,115,99,97,114,100,95,115,111,108,117,116,105,111,110,0,0,0,0,0,0,0,0,42,109,111,118,101,32,61,61,32,39,83,39,0,0,0,0,105,110,115,116,97,108,108,95,110,101,119,95,115,111,108,117,116,105,111,110,0,0,0,0,97,110,103,108,101,32,62,32,45,49,54,46,48,70,0,0,105,110,116,101,114,112,114,101,116,95,109,111,118,101,0,0,37,100,0,0,0,0,0,0,68,37,100,37,110,0,0,0,68,37,100,0,0,0,0,0,37,42,115,43,10,0,0,0,0,0,0,0,0,0,0,0,58,45,40,0,0,0,0,0,124,43,0,0,0,0,0,0,71,97,109,101,32,105,115,32,97,108,114,101,97,100,121,32,115,111,108,118,101,100,0,0,85,110,97,98,108,101,32,116,111,32,102,105,110,100,32,97,32,115,111,108,117,116,105,111,110,32,102,114,111,109,32,116,104,105,115,32,115,116,97,114,116,105,110,103,32,112,111,105,110,116,0,0,0,0,0,0,116,97,114,103,101,116,112,111,115,32,45,32,100,105,115,116,50,91,99,105,114,99,117,105,116,91,110,49,93,93,32,61,61,32,110,49,0,0,0,0,115,111,108,118,101,95,103,97,109,101,0,0,0,0,0,0,116,97,114,103,101,116,112,111,115,32,43,32,100,105,115,116,91,99,105,114,99,117,105,116,91,110,50,93,93,32,61,61,32,110,50,0,0,0,0,0,105,32,60,32,101,105,91,110,105,43,49,93,32,38,38,32,116,105,32,62,61,32,48,0,112,111,115,32,62,61,32,48,32,38,38,32,112,111,115,32,60,32,119,104,0,0,0,0,116,104,105,115,100,105,115,116,32,62,61,32,48,32,38,38,32,116,104,105,115,100,105,115,116,32,60,61,32,113,45,112,0,0,0,0,0,0,0,0,100,101,115,116,32,62,61,32,48,0,0,0,0,0,0,0,107,32,60,32,98,97,99,107,101,100,103,101,105,91,110,105,43,49,93,32,38,38,32,116,105,32,62,61,32,48,0,0,100,32,60,32,68,73,82,69,67,84,73,79,78,83,0,0,112,32,45,32,115,111,108,110,32,60,32,99,105,114,99,117,105,116,108,101,110,43,50,0,100,114,32,62,61,32,48,0,109,111,118,101,95,103,111,101,115,95,116,111,0,0,0,0,115,116,114,108,101,110,40,100,101,115,99,41,32,61,61,32,119,104,0,0,0,0,0,0,110,101,119,95,103,97,109,101,0,0,0,0,0,0,0,0,115,116,97,116,101,45,62,103,101,109,115,32,62,32,48,0,115,116,97,116,101,45,62,112,120,32,62,61,32,48,32,38,38,32,115,116,97,116,101,45,62,112,121,32,62,61,32,48,0,0,0,0,0,0,0,0,78,111,116,32,101,110,111,117,103,104,32,100,97,116,97,32,116,111,32,102,105,108,108,32,103,114,105,100,0,0,0,0,85,110,114,101,99,111,103,110,105,115,101,100,32,99,104,97,114,97,99,116,101,114,32,105,110,32,103,97,109,101,32,100,101,115,99,114,105,112,116,105,111,110,0,0,0,0,0,0,84,111,111,32,109,117,99,104,32,100,97,116,97,32,116,111,32,102,105,108,108,32,103,114,105,100,0,0,0,0,0,0,78,111,32,115,116,97,114,116,105,110,103,32,115,113,117,97,114,101,32,115,112,101,99,105,102,105,101,100,0,0,0,0,77,111,114,101,32,116,104,97,110,32,111,110,101,32,115,116,97,114,116,105,110,103,32,115,113,117,97,114,101,32,115,112,101,99,105,102,105,101,100,0,78,111,32,103,101,109,115,32,115,112,101,99,105,102,105,101,100,0,0,0,0,0,0,0,105,32,60,32,119,104,0,0,103,101,110,103,114,105,100,0,104,101,97,100,32,61,61,32,119,104,32,38,38,32,116,97,105,108,32,61,61,32,119,104,0,0,0,0,0,0,0,0,115,121,32,60,32,104,0,0,102,105,110,100,95,103,101,109,95,99,97,110,100,105,100,97,116,101,115,0,0,0,0,0,87,105,100,116,104,32,97,110,100,32,104,101,105,103,104,116,32,109,117,115,116,32,98,111,116,104,32,98,101,32,97,116,32,108,101,97,115,116,32,116,119,111,0,0,0,0,0,0,71,114,105,100,32,97,114,101,97,32,109,117,115,116,32,98,101,32,97,116,32,108,101,97,115,116,32,115,105,120,32,115,113,117,97,114,101,115,0,0,87,105,100,116,104,0,0,0,72,101,105,103,104,116,0,0,37,100,120,37,100,0,0,0,10,0,0,0,8,0,0,0,15,0,0,0,12,0,0,0,20,0,0,0,16,0,0,0,111,117,116,32,111,102,32,109,101,109,111,114,121,0,0,0,37,115,95,84,73,76,69,83,73,90,69,0,0,0,0,0,37,100,0,0,0,0,0,0,37,115,95,68,69,70,65,85,76,84,0,0,0,0,0,0,109,101,45,62,110,115,116,97,116,101,115,32,61,61,32,48,0,0,0,0,0,0,0,0,109,105,100,101,110,100,46,99,0,0,0,0,0,0,0,0,109,105,100,101,110,100,95,110,101,119,95,103,97,109,101,0,109,111,118,101,115,116,114,32,38,38,32,33,109,115,103,0,115,0,0,0,0,0,0,0,109,101,45,62,115,116,97,116,101,112,111,115,32,62,61,32,49,0,0,0,0,0,0,0,109,105,100,101,110,100,95,114,101,115,116,97,114,116,95,103,97,109,101,0,0,0,0,0,109,101,45,62,100,114,97,119,105,110,103,0,0,0,0,0,109,105,100,101,110,100,95,114,101,100,114,97,119,0,0,0,109,101,45,62,100,105,114,32,33,61,32,48,0,0,0,0,0,0,0,0,0,0,0,0,37,115,95,67,79,76,79,85,82,95,37,100,0,0,0,0,37,50,120,37,50,120,37,50,120,0,0,0,0,0,0,0,33,109,101,45,62,111,117,114,103,97,109,101,45,62,112,114,101,115,101,116,95,109,101,110,117,0,0,0,0,0,0,0,109,105,100,101,110,100,95,103,101,116,95,112,114,101,115,101,116,115,0,0,0,0,0,0,37,115,95,80,82,69,83,69,84,83,0,0,0,0,0,0,119,105,110,116,105,116,108,101,0,0,0,0,0,0,0,0,109,105,100,101,110,100,95,103,101,116,95,99,111,110,102,105,103,0,0,0,0,0,0,0,37,115,32,99,111,110,102,105,103,117,114,97,116,105,111,110,0,0,0,0,0,0,0,0,37,115,32,37,115,32,115,101,108,101,99,116,105,111,110,0,114,97,110,100,111,109,0,0,103,97,109,101,0,0,0,0,71,97,109,101,32,114,97,110,100,111,109,32,115,101,101,100,0,0,0,0,0,0,0,0,71,97,109,101,32,73,68,0,112,97,114,115,116,114,0,0,37,115,37,99,37,115,0,0,33,34,87,101,32,115,104,111,117,108,100,110,39,116,32,98,101,32,104,101,114,101,34,0,109,105,100,101,110,100,95,103,101,116,95,103,97,109,101,95,105,100,0,0,0,0,0,0,109,101,45,62,100,101,115,99,0,0,0,0,0,0,0,0,37,115,58,37,115,0,0,0,109,105,100,101,110,100,95,103,101,116,95,114,97,110,100,111,109,95,115,101,101,100,0,0,37,115,35,37,115,0,0,0,84,104,105,115,32,103,97,109,101,32,100,111,101,115,32,110,111,116,32,115,117,112,112,111,114,116,32,116,104,101,32,83,111,108,118,101,32,111,112,101,114,97,116,105,111,110,0,0,78,111,32,103,97,109,101,32,115,101,116,32,117,112,32,116,111,32,115,111,108,118,101,0,109,111,118,101,115,116,114,32,33,61,32,85,73,95,85,80,68,65,84,69,0,0,0,0,109,105,100,101,110,100,95,115,111,108,118,101,0,0,0,0,83,111,108,118,101,32,111,112,101,114,97,116,105,111,110,32,102,97,105,108,101,100,0,0,91,37,100,58,37,48,50,100,93,32,0,0,0,0,0,0,83,105,109,111,110,32,84,97,116,104,97,109,39,115,32,80,111,114,116,97,98,108,101,32,80,117,122,122,108,101,32,67,111,108,108,101,99,116,105,111,110,0,0,0,0,0,0,0,83,65,86,69,70,73,76,69,0,0,0,0,0,0,0,0,37,115,58,37,100,58,0,0,10,0,0,0,0,0,0,0,49,0,0,0,0,0,0,0,86,69,82,83,73,79,78,0,71,65,77,69,0,0,0,0,80,65,82,65,77,83,0,0,67,80,65,82,65,77,83,0,83,69,69,68,0,0,0,0,68,69,83,67,0,0,0,0,80,82,73,86,68,69,83,67,0,0,0,0,0,0,0,0,65,85,88,73,78,70,79,0,85,73,0,0,0,0,0,0,37,103,0,0,0,0,0,0,84,73,77,69,0,0,0,0,78,83,84,65,84,69,83,0,83,84,65,84,69,80,79,83,0,0,0,0,0,0,0,0,109,101,45,62,115,116,97,116,101,115,91,105,93,46,109,111,118,101,116,121,112,101,32,33,61,32,78,69,87,71,65,77,69,0,0,0,0,0,0,0,109,105,100,101,110,100,95,115,101,114,105,97,108,105,115,101,0,0,0,0,0,0,0,0,77,79,86,69,0,0,0,0,83,79,76,86,69,0,0,0,82,69,83,84,65,82,84,0,68,97,116,97,32,100,111,101,115,32,110,111,116,32,97,112,112,101,97,114,32,116,111,32,98,101,32,97,32,115,97,118,101,100,32,103,97,109,101,32,102,105,108,101,0,0,0,0,68,97,116,97,32,119,97,115,32,105,110,99,111,114,114,101,99,116,108,121,32,102,111,114,109,97,116,116,101,100,32,102,111,114,32,97,32,115,97,118,101,100,32,103,97,109,101,32,102,105,108,101,0,0,0,0,58,32,0,0,0,0,0,0,108,101,110,32,60,61,32,56,0,0,0,0,0,0,0,0,83,97,118,101,100,32,100,97,116,97,32,101,110,100,101,100,32,117,110,101,120,112,101,99,116,101,100,108,121,0,0,0,67,97,110,110,111,116,32,104,97,110,100,108,101,32,116,104,105,115,32,118,101,114,115,105,111,110,32,111,102,32,116,104,101,32,115,97,118,101,100,32,103,97,109,101,32,102,105,108,101,32,102,111,114,109,97,116,0,0,0,0,0,0,0,0,109,105,100,101,110,100,95,100,101,115,101,114,105,97,108,105,115,101,95,105,110,116,101,114,110,97,108,0,0,0,0,0,83,97,118,101,32,102,105,108,101,32,105,115,32,102,114,111,109,32,97,32,100,105,102,102,101,114,101,110,116,32,103,97,109,101,0,0,0,0,0,0,78,117,109,98,101,114,32,111,102,32,115,116,97,116,101,115,32,105,110,32,115,97,118,101,32,102,105,108,101,32,119,97,115,32,110,101,103,97,116,105,118,101,0,0,0,0,0,0,84,119,111,32,115,116,97,116,101,32,99,111,117,110,116,115,32,112,114,111,118,105,100,101,100,32,105,110,32,115,97,118,101,32,102,105,108,101,0,0,76,111,110,103,45,116,101,114,109,32,112,97,114,97,109,101,116,101,114,115,32,105,110,32,115,97,118,101,32,102,105,108,101,32,97,114,101,32,105,110,118,97,108,105,100,0,0,0,83,104,111,114,116,45,116,101,114,109,32,112,97,114,97,109,101,116,101,114,115,32,105,110,32,115,97,118,101,32,102,105,108,101,32,97,114,101,32,105,110,118,97,108,105,100,0,0,71,97,109,101,32,100,101,115,99,114,105,112,116,105,111,110,32,105,110,32,115,97,118,101,32,102,105,108,101,32,105,115,32,109,105,115,115,105,110,103,0,0,0,0,0,0,0,0,71,97,109,101,32,100,101,115,99,114,105,112,116,105,111,110,32,105,110,32,115,97,118,101,32,102,105,108,101,32,105,115,32,105,110,118,97,108,105,100,0,0,0,0,0,0,0,0,71,97,109,101,32,112,114,105,118,97,116,101,32,100,101,115,99,114,105,112,116,105,111,110,32,105,110,32,115,97,118,101,32,102,105,108,101,32,105,115,32,105,110,118,97,108,105,100,0,0,0,0,0,0,0,0,71,97,109,101,32,112,111,115,105,116,105,111,110,32,105,110,32,115,97,118,101,32,102,105,108,101,32,105,115,32,111,117,116,32,111,102,32,114,97,110,103,101,0,0,0,0,0,0,100,97,116,97,46,115,116,97,116,101,115,91,105,93,46,109,111,118,101,116,121,112,101,32,33,61,32,78,69,87,71,65,77,69,0,0,0,0,0,0,83,97,118,101,32,102,105,108,101,32,99,111,110,116,97,105,110,101,100,32,97,110,32,105,110,118,97,108,105,100,32,109,111,118,101,0,0,0,0,0,83,97,118,101,32,102,105,108,101,32,99,111,110,116,97,105,110,101,100,32,97,110,32,105,110,118,97,108,105,100,32,114,101,115,116,97,114,116,32,109,111,118,101,0,0,0,0,0,35,0,0,0,0,0,0,0,115,32,33,61,32,78,85,76,76,0,0,0,0,0,0,0,109,105,100,101,110,100,95,114,101,97,108,108,121,95,112,114,111,99,101,115,115,95,107,101,121,0,0,0,0,0,0,0,109,111,118,101,115,116,114,32,33,61,32,78,85,76,76,0,33,100,101,115,101,114,105,97,108,105,115,101,95,101,114,114,111,114,0,0,0,0,0,0,109,105,100,101,110,100,95,114,101,100,111,0,0,0,0,0,85,110,100,111,105,110,103,32,116,104,105,115,32,110,101,119,45,103,97,109,101,32,111,112,101,114,97,116,105,111,110,32,119,111,117,108,100,32,99,104,97,110,103,101,32,112,97,114,97,109,115,0,0,0,0,0,109,105,100,101,110,100,95,117,110,100,111,0,0,0,0,0,108,101,110,32,60,32,73,78,84,95,77,65,88,32,45,32,115,101,114,45,62,108,101,110,0,0,0,0,0,0,0,0,110,101,119,103,97,109,101,95,115,101,114,105,97,108,105,115,101,95,119,114,105,116,101,0,0,0,0,0,0,0,0,0,37,100,0,0,0,0,0,0,48,49,50,51,52,53,54,55,56,57,97,98,99,100,101,102,0,0,0,0,0,0,0,0,99,32,33,61,32,48,0,0,109,105,115,99,46,99,0,0,104,101,120,50,98,105,110,0,115,122,32,62,32,48,0,0,99,111,112,121,95,108,101,102,116,95,106,117,115,116,105,102,105,101,100,0,0,0,0,0,108,101,110,32,60,61,32,115,122,32,45,32,49,0,0,0,98,105,116,115,32,60,32,51,50,0,0,0,0,0,0,0,114,97,110,100,111,109,46,99,0,0,0,0,0,0,0,0,114,97,110,100,111,109,95,117,112,116,111,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,105,110,102,105,110,105,116,121,0,0,0,0,0,0,0,0,110,97,110,0,0,0,0,0,95,112,137,0,255,9,47,15,10,0,0,0,100,0,0,0,232,3,0,0,16,39,0,0,160,134,1,0,64,66,15,0,128,150,152,0,0,225,245,5], "i8", ALLOC_NONE, Runtime.GLOBAL_BASE);




var tempDoublePtr = Runtime.alignMemory(allocate(12, "i8", ALLOC_STATIC), 8);

assert(tempDoublePtr % 8 == 0);

function copyTempFloat(ptr) { // functions, because inlining this code increases code size too much

    HEAP8[tempDoublePtr] = HEAP8[ptr];

    HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];

    HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];

    HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];

}

function copyTempDouble(ptr) {

    HEAP8[tempDoublePtr] = HEAP8[ptr];

    HEAP8[tempDoublePtr+1] = HEAP8[ptr+1];

    HEAP8[tempDoublePtr+2] = HEAP8[ptr+2];

    HEAP8[tempDoublePtr+3] = HEAP8[ptr+3];

    HEAP8[tempDoublePtr+4] = HEAP8[ptr+4];

    HEAP8[tempDoublePtr+5] = HEAP8[ptr+5];

    HEAP8[tempDoublePtr+6] = HEAP8[ptr+6];

    HEAP8[tempDoublePtr+7] = HEAP8[ptr+7];

}


function _js_update_permalinks(desc, seed) {
    /* desc = Pointer_stringify(desc);
          permalink_desc.href = "#" + desc;

          if (seed == 0) {
              permalink_seed.style.display = "none";
          } else {
              seed = Pointer_stringify(seed);
              permalink_seed.href = "#" + seed;
              permalink_seed.style.display = "inline";
          }*/
}


Module["_i64Add"] = _i64Add;

function _js_canvas_draw_text(x, y, halign, colptr, fontptr, text) {
    ctx.font = Pointer_stringify(fontptr);
    ctx.fillStyle = Pointer_stringify(colptr);
    ctx.textAlign = (halign == 0 ? 'left' :
        halign == 1 ? 'center' : 'right');
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(Pointer_stringify(text), x, y);
}

function _toupper(chr) {
    if (chr >= 97 && chr <= 122) {
        return chr - 97 + 65;
    } else {
        return chr;
    }
}

function _js_canvas_draw_circle(x, y, r, fill, outline) {
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, r, 0, 2*Math.PI);
    if (fill != 0) {
        ctx.fillStyle = Pointer_stringify(fill);
        ctx.fill();
    }
    ctx.lineWidth = '1';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Pointer_stringify(outline);
    ctx.stroke();
}


Module["_i64Subtract"] = _i64Subtract;


Module["_strncpy"] = _strncpy;

function _js_canvas_end_draw() {
    if (update_xmin !== undefined) {
        var onscreen_ctx = onscreen_canvas.getContext('2d');
        onscreen_ctx.drawImage(offscreen_canvas,
            update_xmin, update_ymin,
            update_xmax - update_xmin,
            update_ymax - update_ymin,
            update_xmin, update_ymin,
            update_xmax - update_xmin,
            update_ymax - update_ymin);
    }
    ctx = null;
}

function _js_canvas_start_draw() {
    ctx = offscreen_canvas.getContext('2d');
    update_xmin = update_xmax = update_ymin = update_ymax = undefined;
}

function _js_enable_undo_redo(undo, redo) {
    disable_menu_item(undo_button, (undo == 0));
    disable_menu_item(redo_button, (redo == 0));
}

function _js_add_preset(menuid, ptr, value) {
    var name = Pointer_stringify(ptr);
    var item = document.createElement("li");
    item.setAttribute("data-index", value);
    var tick = document.createElement("span");
    tick.appendChild(document.createTextNode("\u2713"));
    tick.style.color = "transparent";
    tick.style.paddingRight = "0.5em";
    item.appendChild(tick);
    item.appendChild(document.createTextNode(name));
    gametypesubmenus[menuid].appendChild(item);
    gametypeitems.push(item);

    item.onclick = function(event) {
        if (dlg_dimmer === null) {
            gametypeselectedindex = value;
            command(2);
        }
    }
}

function _js_canvas_copy_from_blitter(id, x, y, w, h) {
    ctx.drawImage(blitters[id],
        0, 0, w, h,
        x, y, w, h);
}

function _js_canvas_new_blitter(w, h) {
    var id = blittercount++;
    blitters[id] = document.createElement("canvas");
    blitters[id].width = w;
    blitters[id].height = h;
    return id;
}

function _js_dialog_string(index, title, initialtext) {
    dlg_form.appendChild(document.createTextNode(Pointer_stringify(title)));
    var editbox = document.createElement("input");
    editbox.type = "text";
    editbox.value = Pointer_stringify(initialtext);
    dlg_form.appendChild(editbox);
    dlg_form.appendChild(document.createElement("br"));

    dlg_return_funcs.push(function() {
        dlg_return_sval(index, editbox.value);
    });
}

function _js_canvas_clip_rect(x, y, w, h) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
}

function _isspace(chr) {
    return (chr == 32) || (chr >= 9 && chr <= 13);
}



var ___errno_state=0;function ___setErrNo(value) {
    // For convenient setting and returning of errno.
    HEAP32[((___errno_state)>>2)]=value;
    return value;
}

var ERRNO_CODES={EPERM:1,ENOENT:2,ESRCH:3,EINTR:4,EIO:5,ENXIO:6,E2BIG:7,ENOEXEC:8,EBADF:9,ECHILD:10,EAGAIN:11,EWOULDBLOCK:11,ENOMEM:12,EACCES:13,EFAULT:14,ENOTBLK:15,EBUSY:16,EEXIST:17,EXDEV:18,ENODEV:19,ENOTDIR:20,EISDIR:21,EINVAL:22,ENFILE:23,EMFILE:24,ENOTTY:25,ETXTBSY:26,EFBIG:27,ENOSPC:28,ESPIPE:29,EROFS:30,EMLINK:31,EPIPE:32,EDOM:33,ERANGE:34,ENOMSG:42,EIDRM:43,ECHRNG:44,EL2NSYNC:45,EL3HLT:46,EL3RST:47,ELNRNG:48,EUNATCH:49,ENOCSI:50,EL2HLT:51,EDEADLK:35,ENOLCK:37,EBADE:52,EBADR:53,EXFULL:54,ENOANO:55,EBADRQC:56,EBADSLT:57,EDEADLOCK:35,EBFONT:59,ENOSTR:60,ENODATA:61,ETIME:62,ENOSR:63,ENONET:64,ENOPKG:65,EREMOTE:66,ENOLINK:67,EADV:68,ESRMNT:69,ECOMM:70,EPROTO:71,EMULTIHOP:72,EDOTDOT:73,EBADMSG:74,ENOTUNIQ:76,EBADFD:77,EREMCHG:78,ELIBACC:79,ELIBBAD:80,ELIBSCN:81,ELIBMAX:82,ELIBEXEC:83,ENOSYS:38,ENOTEMPTY:39,ENAMETOOLONG:36,ELOOP:40,EOPNOTSUPP:95,EPFNOSUPPORT:96,ECONNRESET:104,ENOBUFS:105,EAFNOSUPPORT:97,EPROTOTYPE:91,ENOTSOCK:88,ENOPROTOOPT:92,ESHUTDOWN:108,ECONNREFUSED:111,EADDRINUSE:98,ECONNABORTED:103,ENETUNREACH:101,ENETDOWN:100,ETIMEDOUT:110,EHOSTDOWN:112,EHOSTUNREACH:113,EINPROGRESS:115,EALREADY:114,EDESTADDRREQ:89,EMSGSIZE:90,EPROTONOSUPPORT:93,ESOCKTNOSUPPORT:94,EADDRNOTAVAIL:99,ENETRESET:102,EISCONN:106,ENOTCONN:107,ETOOMANYREFS:109,EUSERS:87,EDQUOT:122,ESTALE:116,ENOTSUP:95,ENOMEDIUM:123,EILSEQ:84,EOVERFLOW:75,ECANCELED:125,ENOTRECOVERABLE:131,EOWNERDEAD:130,ESTRPIPE:86};function _sysconf(name) {
    // long sysconf(int name);
    // http://pubs.opengroup.org/onlinepubs/009695399/functions/sysconf.html
    switch(name) {
        case 30: return PAGE_SIZE;
        case 132:
        case 133:
        case 12:
        case 137:
        case 138:
        case 15:
        case 235:
        case 16:
        case 17:
        case 18:
        case 19:
        case 20:
        case 149:
        case 13:
        case 10:
        case 236:
        case 153:
        case 9:
        case 21:
        case 22:
        case 159:
        case 154:
        case 14:
        case 77:
        case 78:
        case 139:
        case 80:
        case 81:
        case 79:
        case 82:
        case 68:
        case 67:
        case 164:
        case 11:
        case 29:
        case 47:
        case 48:
        case 95:
        case 52:
        case 51:
        case 46:
            return 200809;
        case 27:
        case 246:
        case 127:
        case 128:
        case 23:
        case 24:
        case 160:
        case 161:
        case 181:
        case 182:
        case 242:
        case 183:
        case 184:
        case 243:
        case 244:
        case 245:
        case 165:
        case 178:
        case 179:
        case 49:
        case 50:
        case 168:
        case 169:
        case 175:
        case 170:
        case 171:
        case 172:
        case 97:
        case 76:
        case 32:
        case 173:
        case 35:
            return -1;
        case 176:
        case 177:
        case 7:
        case 155:
        case 8:
        case 157:
        case 125:
        case 126:
        case 92:
        case 93:
        case 129:
        case 130:
        case 131:
        case 94:
        case 91:
            return 1;
        case 74:
        case 60:
        case 69:
        case 70:
        case 4:
            return 1024;
        case 31:
        case 42:
        case 72:
            return 32;
        case 87:
        case 26:
        case 33:
            return 2147483647;
        case 34:
        case 1:
            return 47839;
        case 38:
        case 36:
            return 99;
        case 43:
        case 37:
            return 2048;
        case 0: return 2097152;
        case 3: return 65536;
        case 28: return 32768;
        case 44: return 32767;
        case 75: return 16384;
        case 39: return 1000;
        case 89: return 700;
        case 71: return 256;
        case 40: return 255;
        case 2: return 100;
        case 180: return 64;
        case 25: return 20;
        case 5: return 16;
        case 6: return 6;
        case 73: return 4;
        case 84: return 1;
    }
    ___setErrNo(ERRNO_CODES.EINVAL);
    return -1;
}





var _environ=allocate(1, "i32*", ALLOC_STATIC);var ___environ=_environ;function ___buildEnvironment(env) {
    // WARNING: Arbitrary limit!
    var MAX_ENV_VALUES = 64;
    var TOTAL_ENV_SIZE = 1024;

    // Statically allocate memory for the environment.
    var poolPtr;
    var envPtr;
    if (!___buildEnvironment.called) {
        ___buildEnvironment.called = true;
        // Set default values. Use string keys for Closure Compiler compatibility.
        ENV['USER'] = 'root';
        ENV['PATH'] = '/';
        ENV['PWD'] = '/';
        ENV['HOME'] = '/home/emscripten';
        ENV['LANG'] = 'en_US.UTF-8';
        ENV['_'] = './this.program';
        // Allocate memory.
        poolPtr = allocate(TOTAL_ENV_SIZE, 'i8', ALLOC_STATIC);
        envPtr = allocate(MAX_ENV_VALUES * 4,
            'i8*', ALLOC_STATIC);
        HEAP32[((envPtr)>>2)]=poolPtr;
        HEAP32[((_environ)>>2)]=envPtr;
    } else {
        envPtr = HEAP32[((_environ)>>2)];
        poolPtr = HEAP32[((envPtr)>>2)];
    }

    // Collect key=value lines.
    var strings = [];
    var totalSize = 0;
    for (var key in env) {
        if (typeof env[key] === 'string') {
            var line = key + '=' + env[key];
            strings.push(line);
            totalSize += line.length;
        }
    }
    if (totalSize > TOTAL_ENV_SIZE) {
        throw new Error('Environment size exceeded TOTAL_ENV_SIZE!');
    }

    // Make new.
    var ptrSize = 4;
    for (var i = 0; i < strings.length; i++) {
        var line = strings[i];
        writeAsciiToMemory(line, poolPtr);
        HEAP32[(((envPtr)+(i * ptrSize))>>2)]=poolPtr;
        poolPtr += line.length + 1;
    }
    HEAP32[(((envPtr)+(strings.length * ptrSize))>>2)]=0;
}var ENV={};function _getenv(name) {
    // char *getenv(const char *name);
    // http://pubs.opengroup.org/onlinepubs/009695399/functions/getenv.html
    if (name === 0) return 0;
    name = Pointer_stringify(name);
    if (!ENV.hasOwnProperty(name)) return 0;

    if (_getenv.ret) _free(_getenv.ret);
    _getenv.ret = allocate(intArrayFromString(ENV[name]), 'i8', ALLOC_NORMAL);
    return _getenv.ret;
}

function _js_get_selected_preset() {
    return gametypeselectedindex;
}

function _js_canvas_draw_rect(x, y, w, h, colptr) {
    ctx.fillStyle = Pointer_stringify(colptr);
    ctx.fillRect(x, y, w, h);
}

function _js_focus_canvas() {
    onscreen_canvas.focus();
}


function _emscripten_memcpy_big(dest, src, num) {
    HEAPU8.set(HEAPU8.subarray(src, src+num), dest);
    return dest;
}
Module["_memcpy"] = _memcpy;

function _sbrk(bytes) {
    // Implement a Linux-like 'memory area' for our 'process'.
    // Changes the size of the memory area by |bytes|; returns the
    // address of the previous top ('break') of the memory area
    // We control the "dynamic" memory - DYNAMIC_BASE to DYNAMICTOP
    var self = _sbrk;
    if (!self.called) {
        DYNAMICTOP = alignMemoryPage(DYNAMICTOP); // make sure we start out aligned
        self.called = true;
        assert(Runtime.dynamicAlloc);
        self.alloc = Runtime.dynamicAlloc;
        Runtime.dynamicAlloc = function() { abort('cannot dynamically allocate, sbrk now has control') };
    }
    var ret = DYNAMICTOP;
    if (bytes != 0) self.alloc(bytes);
    return ret;  // Previous break location.
}


Module["_memmove"] = _memmove;

function _js_canvas_draw_poly(pointptr, npoints, fill, outline) {
    ctx.beginPath();
    ctx.moveTo(getValue(pointptr  , 'i32') + 0.5,
        getValue(pointptr+4, 'i32') + 0.5);
    for (var i = 1; i < npoints; i++)
        ctx.lineTo(getValue(pointptr+8*i  , 'i32') + 0.5,
            getValue(pointptr+8*i+4, 'i32') + 0.5);
    ctx.closePath();
    if (fill != 0) {
        ctx.fillStyle = Pointer_stringify(fill);
        ctx.fill();
    }
    ctx.lineWidth = '1';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = Pointer_stringify(outline);
    ctx.stroke();
}

function ___errno_location() {
    return ___errno_state;
}

var _BItoD=true;

function _js_canvas_set_statusbar(ptr) {
    var text = Pointer_stringify(ptr);

    if(text == "COMPLETED!"){
        //alert("udane");
        sendResult(1);
        showGameResult();

    }
    if(text == "DEAD!   Deaths: 1"){
        sendResult(0);
    }
    statusbar.replaceChild(document.createTextNode(text),
        statusbar.lastChild);

}

function _js_canvas_make_statusbar() {
    var statusholder = document.getElementById("statusbarholder");
    statusbar = document.createElement("div");
    statusbar.style.overflow = "hidden";
    //statusbar.style.width = (onscreen_canvas.width - 4) + "px";
    statusholder.style.width = onscreen_canvas.width + "px";
    //statusbar.style.height = "1.2em";
    statusbar.style.textAlign = "left";
    statusbar.style.background = 'brown';
    statusbar.style.borderLeft = '2px solid brown';
    statusbar.style.borderTop = '2px solid brown';
    statusbar.style.borderRight = '2px solid brown';
    statusbar.style.borderBottom = '2px solid brown';
    statusbar.style.color = 'white';
    statusbar.style.fontFamily ="'Dekko', cursive";
    statusbar.style.paddingLeft = '10px';
    statusbar.style.fontSize = '1em';
    statusbar.style.boxSizing = 'border-box';
    statusbar.appendChild(document.createTextNode(" "));
    statusholder.appendChild(statusbar);
}

function _js_activate_timer() {
    if (timer === null) {
        timer_reference_date = (new Date()).valueOf();
        timer = setInterval(function() {
            var now = (new Date()).valueOf();
            timer_callback((now - timer_reference_date) / 1000.0);
            timer_reference_date = now;
            return true;
        }, 20);
        //showGameResult();
    }
}

function showGameResult(){
    //alert(timer_reference_date - preloadStartTime);
    var modal = document.getElementById('myModal');
    var ms = timer_reference_date - preloadStartTime;
    var min = Math.floor((ms/1000/60) << 0);
    var sec = Math.floor((ms/1000) % 60);
    document.getElementById('timeSummary').innerHTML= min+ "<b>	min </b>"+ sec + "<b> s</b>";

    if(ms < 60000){
        points = points + 1;
    } else if(ms > 300000){
        points = points + 0.1;
    } else {
        points = points + (((-0.00000375) * ms) + 0.999775);
    }
    modal.style.display = "block";
}

function closeModal(){
    var modal = document.getElementById('myModal');
    modal.style.display = "none";
}

function _js_canvas_set_size(w, h) {
    onscreen_canvas.width = w;
    offscreen_canvas.width = w;
    if (statusbar !== null) {
        statusbar.style.width = (w - 4) + "px";
        document.getElementById("statusbarholder").style.width = w + "px";
    }
    resizable_div.style.width = w + "px";

    onscreen_canvas.height = h;
    offscreen_canvas.height = h;
}

function _js_select_preset(n) {
    gametypeselectedindex = n;
    for (var i in gametypeitems) {
        var item = gametypeitems[i];
        var tick = item.firstChild;
        if (item.getAttribute("data-index") == n) {
            tick.style.color = "inherit";
        } else {
            tick.style.color = "transparent";
        }
    }
}

function _fmod(x, y) {
    return x % y;
}



function __getFloat(text) {
    return /^[+-]?[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/.exec(text);
}function __scanString(format, get, unget, varargs) {
    if (!__scanString.whiteSpace) {
        __scanString.whiteSpace = {};
        __scanString.whiteSpace[32] = 1;
        __scanString.whiteSpace[9] = 1;
        __scanString.whiteSpace[10] = 1;
        __scanString.whiteSpace[11] = 1;
        __scanString.whiteSpace[12] = 1;
        __scanString.whiteSpace[13] = 1;
    }
    // Supports %x, %4x, %d.%d, %lld, %s, %f, %lf.
    // TODO: Support all format specifiers.
    format = Pointer_stringify(format);
    var soFar = 0;
    if (format.indexOf('%n') >= 0) {
        // need to track soFar
        var _get = get;
        get = function get() {
            soFar++;
            return _get();
        }
        var _unget = unget;
        unget = function unget() {
            soFar--;
            return _unget();
        }
    }
    var formatIndex = 0;
    var argsi = 0;
    var fields = 0;
    var argIndex = 0;
    var next;

    mainLoop:
        for (var formatIndex = 0; formatIndex < format.length;) {
            if (format[formatIndex] === '%' && format[formatIndex+1] == 'n') {
                var argPtr = HEAP32[(((varargs)+(argIndex))>>2)];
                argIndex += Runtime.getAlignSize('void*', null, true);
                HEAP32[((argPtr)>>2)]=soFar;
                formatIndex += 2;
                continue;
            }

            if (format[formatIndex] === '%') {
                var nextC = format.indexOf('c', formatIndex+1);
                if (nextC > 0) {
                    var maxx = 1;
                    if (nextC > formatIndex+1) {
                        var sub = format.substring(formatIndex+1, nextC);
                        maxx = parseInt(sub);
                        if (maxx != sub) maxx = 0;
                    }
                    if (maxx) {
                        var argPtr = HEAP32[(((varargs)+(argIndex))>>2)];
                        argIndex += Runtime.getAlignSize('void*', null, true);
                        fields++;
                        for (var i = 0; i < maxx; i++) {
                            next = get();
                            HEAP8[((argPtr++)|0)]=next;
                            if (next === 0) return i > 0 ? fields : fields-1; // we failed to read the full length of this field
                        }
                        formatIndex += nextC - formatIndex + 1;
                        continue;
                    }
                }
            }

            // handle %[...]
            if (format[formatIndex] === '%' && format.indexOf('[', formatIndex+1) > 0) {
                var match = /\%([0-9]*)\[(\^)?(\]?[^\]]*)\]/.exec(format.substring(formatIndex));
                if (match) {
                    var maxNumCharacters = parseInt(match[1]) || Infinity;
                    var negateScanList = (match[2] === '^');
                    var scanList = match[3];

                    // expand "middle" dashs into character sets
                    var middleDashMatch;
                    while ((middleDashMatch = /([^\-])\-([^\-])/.exec(scanList))) {
                        var rangeStartCharCode = middleDashMatch[1].charCodeAt(0);
                        var rangeEndCharCode = middleDashMatch[2].charCodeAt(0);
                        for (var expanded = ''; rangeStartCharCode <= rangeEndCharCode; expanded += String.fromCharCode(rangeStartCharCode++));
                        scanList = scanList.replace(middleDashMatch[1] + '-' + middleDashMatch[2], expanded);
                    }

                    var argPtr = HEAP32[(((varargs)+(argIndex))>>2)];
                    argIndex += Runtime.getAlignSize('void*', null, true);
                    fields++;

                    for (var i = 0; i < maxNumCharacters; i++) {
                        next = get();
                        if (negateScanList) {
                            if (scanList.indexOf(String.fromCharCode(next)) < 0) {
                                HEAP8[((argPtr++)|0)]=next;
                            } else {
                                unget();
                                break;
                            }
                        } else {
                            if (scanList.indexOf(String.fromCharCode(next)) >= 0) {
                                HEAP8[((argPtr++)|0)]=next;
                            } else {
                                unget();
                                break;
                            }
                        }
                    }

                    // write out null-terminating character
                    HEAP8[((argPtr++)|0)]=0;
                    formatIndex += match[0].length;

                    continue;
                }
            }
            // remove whitespace
            while (1) {
                next = get();
                if (next == 0) return fields;
                if (!(next in __scanString.whiteSpace)) break;
            }
            unget();

            if (format[formatIndex] === '%') {
                formatIndex++;
                var suppressAssignment = false;
                if (format[formatIndex] == '*') {
                    suppressAssignment = true;
                    formatIndex++;
                }
                var maxSpecifierStart = formatIndex;
                while (format[formatIndex].charCodeAt(0) >= 48 &&
                format[formatIndex].charCodeAt(0) <= 57) {
                    formatIndex++;
                }
                var max_;
                if (formatIndex != maxSpecifierStart) {
                    max_ = parseInt(format.slice(maxSpecifierStart, formatIndex), 10);
                }
                var long_ = false;
                var half = false;
                var longLong = false;
                if (format[formatIndex] == 'l') {
                    long_ = true;
                    formatIndex++;
                    if (format[formatIndex] == 'l') {
                        longLong = true;
                        formatIndex++;
                    }
                } else if (format[formatIndex] == 'h') {
                    half = true;
                    formatIndex++;
                }
                var type = format[formatIndex];
                formatIndex++;
                var curr = 0;
                var buffer = [];
                // Read characters according to the format. floats are trickier, they may be in an unfloat state in the middle, then be a valid float later
                if (type == 'f' || type == 'e' || type == 'g' ||
                    type == 'F' || type == 'E' || type == 'G') {
                    next = get();
                    while (next > 0 && (!(next in __scanString.whiteSpace)))  {
                        buffer.push(String.fromCharCode(next));
                        next = get();
                    }
                    var m = __getFloat(buffer.join(''));
                    var last = m ? m[0].length : 0;
                    for (var i = 0; i < buffer.length - last + 1; i++) {
                        unget();
                    }
                    buffer.length = last;
                } else {
                    next = get();
                    var first = true;

                    // Strip the optional 0x prefix for %x.
                    if ((type == 'x' || type == 'X') && (next == 48)) {
                        var peek = get();
                        if (peek == 120 || peek == 88) {
                            next = get();
                        } else {
                            unget();
                        }
                    }

                    while ((curr < max_ || isNaN(max_)) && next > 0) {
                        if (!(next in __scanString.whiteSpace) && // stop on whitespace
                            (type == 's' ||
                                ((type === 'd' || type == 'u' || type == 'i') && ((next >= 48 && next <= 57) ||
                                    (first && next == 45))) ||
                                ((type === 'x' || type === 'X') && (next >= 48 && next <= 57 ||
                                    next >= 97 && next <= 102 ||
                                    next >= 65 && next <= 70))) &&
                            (formatIndex >= format.length || next !== format[formatIndex].charCodeAt(0))) { // Stop when we read something that is coming up
                            buffer.push(String.fromCharCode(next));
                            next = get();
                            curr++;
                            first = false;
                        } else {
                            break;
                        }
                    }
                    unget();
                }
                if (buffer.length === 0) return 0;  // Failure.
                if (suppressAssignment) continue;

                var text = buffer.join('');
                var argPtr = HEAP32[(((varargs)+(argIndex))>>2)];
                argIndex += Runtime.getAlignSize('void*', null, true);
                switch (type) {
                    case 'd': case 'u': case 'i':
                    if (half) {
                        HEAP16[((argPtr)>>1)]=parseInt(text, 10);
                    } else if (longLong) {
                        (tempI64 = [parseInt(text, 10)>>>0,(tempDouble=parseInt(text, 10),(+(Math_abs(tempDouble))) >= (+1) ? (tempDouble > (+0) ? ((Math_min((+(Math_floor((tempDouble)/(+4294967296)))), (+4294967295)))|0)>>>0 : (~~((+(Math_ceil((tempDouble - +(((~~(tempDouble)))>>>0))/(+4294967296))))))>>>0) : 0)],HEAP32[((argPtr)>>2)]=tempI64[0],HEAP32[(((argPtr)+(4))>>2)]=tempI64[1]);
                    } else {
                        HEAP32[((argPtr)>>2)]=parseInt(text, 10);
                    }
                    break;
                    case 'X':
                    case 'x':
                        HEAP32[((argPtr)>>2)]=parseInt(text, 16);
                        break;
                    case 'F':
                    case 'f':
                    case 'E':
                    case 'e':
                    case 'G':
                    case 'g':
                    case 'E':
                        // fallthrough intended
                        if (long_) {
                            HEAPF64[((argPtr)>>3)]=parseFloat(text);
                        } else {
                            HEAPF32[((argPtr)>>2)]=parseFloat(text);
                        }
                        break;
                    case 's':
                        var array = intArrayFromString(text);
                        for (var j = 0; j < array.length; j++) {
                            HEAP8[(((argPtr)+(j))|0)]=array[j];
                        }
                        break;
                }
                fields++;
            } else if (format[formatIndex].charCodeAt(0) in __scanString.whiteSpace) {
                next = get();
                while (next in __scanString.whiteSpace) {
                    if (next <= 0) break mainLoop;  // End of input.
                    next = get();
                }
                unget(next);
                formatIndex++;
            } else {
                // Not a specifier.
                next = get();
                if (format[formatIndex].charCodeAt(0) !== next) {
                    unget(next);
                    break mainLoop;
                }
                formatIndex++;
            }
        }
    return fields;
}function _sscanf(s, format, varargs) {
    // int sscanf(const char *restrict s, const char *restrict format, ... );
    // http://pubs.opengroup.org/onlinepubs/000095399/functions/scanf.html
    var index = 0;
    function get() { return HEAP8[(((s)+(index++))|0)]; };
    function unget() { index--; };
    return __scanString(format, get, unget, varargs);
}

var _fmodl=_fmod;





Module["_strlen"] = _strlen;

function __reallyNegative(x) {
    return x < 0 || (x === 0 && (1/x) === -Infinity);
}function __formatString(format, varargs) {
    var textIndex = format;
    var argIndex = 0;
    function getNextArg(type) {
        // NOTE: Explicitly ignoring type safety. Otherwise this fails:
        //       int x = 4; printf("%c\n", (char)x);
        var ret;
        if (type === 'double') {
            ret = (HEAP32[((tempDoublePtr)>>2)]=HEAP32[(((varargs)+(argIndex))>>2)],HEAP32[(((tempDoublePtr)+(4))>>2)]=HEAP32[(((varargs)+((argIndex)+(4)))>>2)],(+(HEAPF64[(tempDoublePtr)>>3])));
        } else if (type == 'i64') {
            ret = [HEAP32[(((varargs)+(argIndex))>>2)],
                HEAP32[(((varargs)+(argIndex+4))>>2)]];

        } else {
            type = 'i32'; // varargs are always i32, i64, or double
            ret = HEAP32[(((varargs)+(argIndex))>>2)];
        }
        argIndex += Runtime.getNativeFieldSize(type);
        return ret;
    }

    var ret = [];
    var curr, next, currArg;
    while(1) {
        var startTextIndex = textIndex;
        curr = HEAP8[(textIndex)];
        if (curr === 0) break;
        next = HEAP8[((textIndex+1)|0)];
        if (curr == 37) {
            // Handle flags.
            var flagAlwaysSigned = false;
            var flagLeftAlign = false;
            var flagAlternative = false;
            var flagZeroPad = false;
            var flagPadSign = false;
            flagsLoop: while (1) {
                switch (next) {
                    case 43:
                        flagAlwaysSigned = true;
                        break;
                    case 45:
                        flagLeftAlign = true;
                        break;
                    case 35:
                        flagAlternative = true;
                        break;
                    case 48:
                        if (flagZeroPad) {
                            break flagsLoop;
                        } else {
                            flagZeroPad = true;
                            break;
                        }
                    case 32:
                        flagPadSign = true;
                        break;
                    default:
                        break flagsLoop;
                }
                textIndex++;
                next = HEAP8[((textIndex+1)|0)];
            }

            // Handle width.
            var width = 0;
            if (next == 42) {
                width = getNextArg('i32');
                textIndex++;
                next = HEAP8[((textIndex+1)|0)];
            } else {
                while (next >= 48 && next <= 57) {
                    width = width * 10 + (next - 48);
                    textIndex++;
                    next = HEAP8[((textIndex+1)|0)];
                }
            }

            // Handle precision.
            var precisionSet = false, precision = -1;
            if (next == 46) {
                precision = 0;
                precisionSet = true;
                textIndex++;
                next = HEAP8[((textIndex+1)|0)];
                if (next == 42) {
                    precision = getNextArg('i32');
                    textIndex++;
                } else {
                    while(1) {
                        var precisionChr = HEAP8[((textIndex+1)|0)];
                        if (precisionChr < 48 ||
                            precisionChr > 57) break;
                        precision = precision * 10 + (precisionChr - 48);
                        textIndex++;
                    }
                }
                next = HEAP8[((textIndex+1)|0)];
            }
            if (precision < 0) {
                precision = 6; // Standard default.
                precisionSet = false;
            }

            // Handle integer sizes. WARNING: These assume a 32-bit architecture!
            var argSize;
            switch (String.fromCharCode(next)) {
                case 'h':
                    var nextNext = HEAP8[((textIndex+2)|0)];
                    if (nextNext == 104) {
                        textIndex++;
                        argSize = 1; // char (actually i32 in varargs)
                    } else {
                        argSize = 2; // short (actually i32 in varargs)
                    }
                    break;
                case 'l':
                    var nextNext = HEAP8[((textIndex+2)|0)];
                    if (nextNext == 108) {
                        textIndex++;
                        argSize = 8; // long long
                    } else {
                        argSize = 4; // long
                    }
                    break;
                case 'L': // long long
                case 'q': // int64_t
                case 'j': // intmax_t
                    argSize = 8;
                    break;
                case 'z': // size_t
                case 't': // ptrdiff_t
                case 'I': // signed ptrdiff_t or unsigned size_t
                    argSize = 4;
                    break;
                default:
                    argSize = null;
            }
            if (argSize) textIndex++;
            next = HEAP8[((textIndex+1)|0)];

            // Handle type specifier.
            switch (String.fromCharCode(next)) {
                case 'd': case 'i': case 'u': case 'o': case 'x': case 'X': case 'p': {
                // Integer.
                var signed = next == 100 || next == 105;
                argSize = argSize || 4;
                var currArg = getNextArg('i' + (argSize * 8));
                var origArg = currArg;
                var argText;
                // Flatten i64-1 [low, high] into a (slightly rounded) double
                if (argSize == 8) {
                    currArg = Runtime.makeBigInt(currArg[0], currArg[1], next == 117);
                }
                // Truncate to requested size.
                if (argSize <= 4) {
                    var limit = Math.pow(256, argSize) - 1;
                    currArg = (signed ? reSign : unSign)(currArg & limit, argSize * 8);
                }
                // Format the number.
                var currAbsArg = Math.abs(currArg);
                var prefix = '';
                if (next == 100 || next == 105) {
                    if (argSize == 8 && i64Math) argText = i64Math.stringify(origArg[0], origArg[1], null); else
                        argText = reSign(currArg, 8 * argSize, 1).toString(10);
                } else if (next == 117) {
                    if (argSize == 8 && i64Math) argText = i64Math.stringify(origArg[0], origArg[1], true); else
                        argText = unSign(currArg, 8 * argSize, 1).toString(10);
                    currArg = Math.abs(currArg);
                } else if (next == 111) {
                    argText = (flagAlternative ? '0' : '') + currAbsArg.toString(8);
                } else if (next == 120 || next == 88) {
                    prefix = (flagAlternative && currArg != 0) ? '0x' : '';
                    if (argSize == 8 && i64Math) {
                        if (origArg[1]) {
                            argText = (origArg[1]>>>0).toString(16);
                            var lower = (origArg[0]>>>0).toString(16);
                            while (lower.length < 8) lower = '0' + lower;
                            argText += lower;
                        } else {
                            argText = (origArg[0]>>>0).toString(16);
                        }
                    } else
                    if (currArg < 0) {
                        // Represent negative numbers in hex as 2's complement.
                        currArg = -currArg;
                        argText = (currAbsArg - 1).toString(16);
                        var buffer = [];
                        for (var i = 0; i < argText.length; i++) {
                            buffer.push((0xF - parseInt(argText[i], 16)).toString(16));
                        }
                        argText = buffer.join('');
                        while (argText.length < argSize * 2) argText = 'f' + argText;
                    } else {
                        argText = currAbsArg.toString(16);
                    }
                    if (next == 88) {
                        prefix = prefix.toUpperCase();
                        argText = argText.toUpperCase();
                    }
                } else if (next == 112) {
                    if (currAbsArg === 0) {
                        argText = '(nil)';
                    } else {
                        prefix = '0x';
                        argText = currAbsArg.toString(16);
                    }
                }
                if (precisionSet) {
                    while (argText.length < precision) {
                        argText = '0' + argText;
                    }
                }

                // Add sign if needed
                if (currArg >= 0) {
                    if (flagAlwaysSigned) {
                        prefix = '+' + prefix;
                    } else if (flagPadSign) {
                        prefix = ' ' + prefix;
                    }
                }

                // Move sign to prefix so we zero-pad after the sign
                if (argText.charAt(0) == '-') {
                    prefix = '-' + prefix;
                    argText = argText.substr(1);
                }

                // Add padding.
                while (prefix.length + argText.length < width) {
                    if (flagLeftAlign) {
                        argText += ' ';
                    } else {
                        if (flagZeroPad) {
                            argText = '0' + argText;
                        } else {
                            prefix = ' ' + prefix;
                        }
                    }
                }

                // Insert the result into the buffer.
                argText = prefix + argText;
                argText.split('').forEach(function(chr) {
                    ret.push(chr.charCodeAt(0));
                });
                break;
            }
                case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
                // Float.
                var currArg = getNextArg('double');
                var argText;
                if (isNaN(currArg)) {
                    argText = 'nan';
                    flagZeroPad = false;
                } else if (!isFinite(currArg)) {
                    argText = (currArg < 0 ? '-' : '') + 'inf';
                    flagZeroPad = false;
                } else {
                    var isGeneral = false;
                    var effectivePrecision = Math.min(precision, 20);

                    // Convert g/G to f/F or e/E, as per:
                    // http://pubs.opengroup.org/onlinepubs/9699919799/functions/printf.html
                    if (next == 103 || next == 71) {
                        isGeneral = true;
                        precision = precision || 1;
                        var exponent = parseInt(currArg.toExponential(effectivePrecision).split('e')[1], 10);
                        if (precision > exponent && exponent >= -4) {
                            next = ((next == 103) ? 'f' : 'F').charCodeAt(0);
                            precision -= exponent + 1;
                        } else {
                            next = ((next == 103) ? 'e' : 'E').charCodeAt(0);
                            precision--;
                        }
                        effectivePrecision = Math.min(precision, 20);
                    }

                    if (next == 101 || next == 69) {
                        argText = currArg.toExponential(effectivePrecision);
                        // Make sure the exponent has at least 2 digits.
                        if (/[eE][-+]\d$/.test(argText)) {
                            argText = argText.slice(0, -1) + '0' + argText.slice(-1);
                        }
                    } else if (next == 102 || next == 70) {
                        argText = currArg.toFixed(effectivePrecision);
                        if (currArg === 0 && __reallyNegative(currArg)) {
                            argText = '-' + argText;
                        }
                    }

                    var parts = argText.split('e');
                    if (isGeneral && !flagAlternative) {
                        // Discard trailing zeros and periods.
                        while (parts[0].length > 1 && parts[0].indexOf('.') != -1 &&
                        (parts[0].slice(-1) == '0' || parts[0].slice(-1) == '.')) {
                            parts[0] = parts[0].slice(0, -1);
                        }
                    } else {
                        // Make sure we have a period in alternative mode.
                        if (flagAlternative && argText.indexOf('.') == -1) parts[0] += '.';
                        // Zero pad until required precision.
                        while (precision > effectivePrecision++) parts[0] += '0';
                    }
                    argText = parts[0] + (parts.length > 1 ? 'e' + parts[1] : '');

                    // Capitalize 'E' if needed.
                    if (next == 69) argText = argText.toUpperCase();

                    // Add sign.
                    if (currArg >= 0) {
                        if (flagAlwaysSigned) {
                            argText = '+' + argText;
                        } else if (flagPadSign) {
                            argText = ' ' + argText;
                        }
                    }
                }

                // Add padding.
                while (argText.length < width) {
                    if (flagLeftAlign) {
                        argText += ' ';
                    } else {
                        if (flagZeroPad && (argText[0] == '-' || argText[0] == '+')) {
                            argText = argText[0] + '0' + argText.slice(1);
                        } else {
                            argText = (flagZeroPad ? '0' : ' ') + argText;
                        }
                    }
                }

                // Adjust case.
                if (next < 97) argText = argText.toUpperCase();

                // Insert the result into the buffer.
                argText.split('').forEach(function(chr) {
                    ret.push(chr.charCodeAt(0));
                });
                break;
            }
                case 's': {
                    // String.
                    var arg = getNextArg('i8*');
                    var argLength = arg ? _strlen(arg) : '(null)'.length;
                    if (precisionSet) argLength = Math.min(argLength, precision);
                    if (!flagLeftAlign) {
                        while (argLength < width--) {
                            ret.push(32);
                        }
                    }
                    if (arg) {
                        for (var i = 0; i < argLength; i++) {
                            ret.push(HEAPU8[((arg++)|0)]);
                        }
                    } else {
                        ret = ret.concat(intArrayFromString('(null)'.substr(0, argLength), true));
                    }
                    if (flagLeftAlign) {
                        while (argLength < width--) {
                            ret.push(32);
                        }
                    }
                    break;
                }
                case 'c': {
                    // Character.
                    if (flagLeftAlign) ret.push(getNextArg('i8'));
                    while (--width > 0) {
                        ret.push(32);
                    }
                    if (!flagLeftAlign) ret.push(getNextArg('i8'));
                    break;
                }
                case 'n': {
                    // Write the length written so far to the next parameter.
                    var ptr = getNextArg('i32*');
                    HEAP32[((ptr)>>2)]=ret.length;
                    break;
                }
                case '%': {
                    // Literal percent sign.
                    ret.push(curr);
                    break;
                }
                default: {
                    // Unknown specifiers remain untouched.
                    for (var i = startTextIndex; i < textIndex + 2; i++) {
                        ret.push(HEAP8[(i)]);
                    }
                }
            }
            textIndex += 2;
            // TODO: Support a/A (hex float) and m (last error) specifiers.
            // TODO: Support %1${specifier} for arg selection.
        } else {
            ret.push(curr);
            textIndex += 1;
        }
    }
    return ret;
}

function _malloc(bytes) {
    /* Over-allocate to make sure it is byte-aligned by 8.
       * This will leak memory, but this is only the dummy
       * implementation (replaced by dlmalloc normally) so
       * not an issue.
       */
    var ptr = Runtime.dynamicAlloc(bytes + 8);
    return (ptr+8) & 0xFFFFFFF8;
}
Module["_malloc"] = _malloc;function _snprintf(s, n, format, varargs) {
    // int snprintf(char *restrict s, size_t n, const char *restrict format, ...);
    // http://pubs.opengroup.org/onlinepubs/000095399/functions/printf.html
    var result = __formatString(format, varargs);
    var limit = (n === undefined) ? result.length
        : Math.min(result.length, Math.max(n - 1, 0));
    if (s < 0) {
        s = -s;
        var buf = _malloc(limit+1);
        HEAP32[((s)>>2)]=buf;
        s = buf;
    }
    for (var i = 0; i < limit; i++) {
        HEAP8[(((s)+(i))|0)]=result[i];
    }
    if (limit < n || (n === undefined)) HEAP8[(((s)+(i))|0)]=0;
    return result.length;
}function _vsnprintf(s, n, format, va_arg) {
    return _snprintf(s, n, format, HEAP32[((va_arg)>>2)]);
}

function _js_canvas_free_blitter(id) {
    blitters[id] = null;
}

function ___assert_fail(condition, filename, line, func) {
    ABORT = true;
    throw 'Assertion failed: ' + Pointer_stringify(condition) + ', at: ' + [filename ? Pointer_stringify(filename) : 'unknown filename', line, func ? Pointer_stringify(func) : 'unknown function'] + ' at ' + stackTrace();
}


Module["_memset"] = _memset;


Module["_strcat"] = _strcat;

function _js_canvas_draw_update(x, y, w, h) {
    /*
           * Currently we do this in a really simple way, just by taking
           * the smallest rectangle containing all updates so far. We
           * could instead keep the data in a richer form (e.g. retain
           * multiple smaller rectangles needing update, and only redraw
           * the whole thing beyond a certain threshold) but this will
           * do for now.
           */
    if (update_xmin === undefined || update_xmin > x) update_xmin = x;
    if (update_ymin === undefined || update_ymin > y) update_ymin = y;
    if (update_xmax === undefined || update_xmax < x+w) update_xmax = x+w;
    if (update_ymax === undefined || update_ymax < y+h) update_ymax = y+h;
}

function _js_canvas_find_font_midpoint(height, font) {
    font = Pointer_stringify(font);

    // Reuse cached value if possible
    if (midpoint_cache[font] !== undefined)
        return midpoint_cache[font];

    // Find the width of the string
    var ctx1 = onscreen_canvas.getContext('2d');
    ctx1.font = font;
    var width = (ctx1.measureText(midpoint_test_str).width + 1) | 0;

    // Construct a test canvas of appropriate size, initialise it to
    // black, and draw the string on it in white
    var measure_canvas = document.createElement('canvas');
    var ctx2 = measure_canvas.getContext('2d');
    ctx2.canvas.width = width;
    ctx2.canvas.height = 2*height;
    ctx2.fillStyle = "#000000";
    ctx2.fillRect(0, 0, width, 2*height);
    var baseline = (1.5*height) | 0;
    ctx2.fillStyle = "#ffffff";
    ctx2.font = font;
    ctx2.fillText(midpoint_test_str, 0, baseline);

    // Scan the contents of the test canvas to find the top and bottom
    // set pixels.
    var pixels = ctx2.getImageData(0, 0, width, 2*height).data;
    var ymin = 2*height, ymax = -1;
    for (var y = 0; y < 2*height; y++) {
        for (var x = 0; x < width; x++) {
            if (pixels[4*(y*width+x)] != 0) {
                if (ymin > y) ymin = y;
                if (ymax < y) ymax = y;
                break;
            }
        }
    }

    var ret = (baseline - (ymin + ymax) / 2) | 0;
    midpoint_cache[font] = ret;
    return ret;
}


Module["_bitshift64Shl"] = _bitshift64Shl;

function _abort() {
    Module['abort']();
}

function _isdigit(chr) {
    return chr >= 48 && chr <= 57;
}

function _js_get_date_64(ptr) {
    var d = (new Date()).valueOf();
    setValue(ptr, d, 'i64');
}


var _fabs=Math_abs;

var _sqrt=Math_sqrt;

function _js_dialog_cleanup() {
    dialog_cleanup();
}

var _abs=Math_abs;




var ERRNO_MESSAGES={0:"Success",1:"Not super-user",2:"No such file or directory",3:"No such process",4:"Interrupted system call",5:"I/O error",6:"No such device or address",7:"Arg list too long",8:"Exec format error",9:"Bad file number",10:"No children",11:"No more processes",12:"Not enough core",13:"Permission denied",14:"Bad address",15:"Block device required",16:"Mount device busy",17:"File exists",18:"Cross-device link",19:"No such device",20:"Not a directory",21:"Is a directory",22:"Invalid argument",23:"Too many open files in system",24:"Too many open files",25:"Not a typewriter",26:"Text file busy",27:"File too large",28:"No space left on device",29:"Illegal seek",30:"Read only file system",31:"Too many links",32:"Broken pipe",33:"Math arg out of domain of func",34:"Math result not representable",35:"File locking deadlock error",36:"File or path name too long",37:"No record locks available",38:"Function not implemented",39:"Directory not empty",40:"Too many symbolic links",42:"No message of desired type",43:"Identifier removed",44:"Channel number out of range",45:"Level 2 not synchronized",46:"Level 3 halted",47:"Level 3 reset",48:"Link number out of range",49:"Protocol driver not attached",50:"No CSI structure available",51:"Level 2 halted",52:"Invalid exchange",53:"Invalid request descriptor",54:"Exchange full",55:"No anode",56:"Invalid request code",57:"Invalid slot",59:"Bad font file fmt",60:"Device not a stream",61:"No data (for no delay io)",62:"Timer expired",63:"Out of streams resources",64:"Machine is not on the network",65:"Package not installed",66:"The object is remote",67:"The link has been severed",68:"Advertise error",69:"Srmount error",70:"Communication error on send",71:"Protocol error",72:"Multihop attempted",73:"Cross mount point (not really error)",74:"Trying to read unreadable message",75:"Value too large for defined data type",76:"Given log. name not unique",77:"f.d. invalid for this operation",78:"Remote address changed",79:"Can   access a needed shared lib",80:"Accessing a corrupted shared lib",81:".lib section in a.out corrupted",82:"Attempting to link in too many libs",83:"Attempting to exec a shared library",84:"Illegal byte sequence",86:"Streams pipe error",87:"Too many users",88:"Socket operation on non-socket",89:"Destination address required",90:"Message too long",91:"Protocol wrong type for socket",92:"Protocol not available",93:"Unknown protocol",94:"Socket type not supported",95:"Not supported",96:"Protocol family not supported",97:"Address family not supported by protocol family",98:"Address already in use",99:"Address not available",100:"Network interface is not configured",101:"Network is unreachable",102:"Connection reset by network",103:"Connection aborted",104:"Connection reset by peer",105:"No buffer space available",106:"Socket is already connected",107:"Socket is not connected",108:"Can't send after socket shutdown",109:"Too many references",110:"Connection timed out",111:"Connection refused",112:"Host is down",113:"Host is unreachable",114:"Socket already connected",115:"Connection already in progress",116:"Stale file handle",122:"Quota exceeded",123:"No medium (in tape drive)",125:"Operation canceled",130:"Previous owner died",131:"State not recoverable"};

var TTY={ttys:[],init:function () {
        // https://github.com/kripken/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // currently, FS.init does not distinguish if process.stdin is a file or TTY
        //   // device, it always assumes it's a TTY device. because of this, we're forcing
        //   // process.stdin to UTF8 encoding to at least make stdin reading compatible
        //   // with text files until FS.init can be refactored.
        //   process['stdin']['setEncoding']('utf8');
        // }
    },shutdown:function () {
        // https://github.com/kripken/emscripten/pull/1555
        // if (ENVIRONMENT_IS_NODE) {
        //   // inolen: any idea as to why node -e 'process.stdin.read()' wouldn't exit immediately (with process.stdin being a tty)?
        //   // isaacs: because now it's reading from the stream, you've expressed interest in it, so that read() kicks off a _read() which creates a ReadReq operation
        //   // inolen: I thought read() in that case was a synchronous operation that just grabbed some amount of buffered data if it exists?
        //   // isaacs: it is. but it also triggers a _read() call, which calls readStart() on the handle
        //   // isaacs: do process.stdin.pause() and i'd think it'd probably close the pending call
        //   process['stdin']['pause']();
        // }
    },register:function (dev, ops) {
        TTY.ttys[dev] = { input: [], output: [], ops: ops };
        FS.registerDevice(dev, TTY.stream_ops);
    },stream_ops:{open:function (stream) {
            var tty = TTY.ttys[stream.node.rdev];
            if (!tty) {
                throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
            }
            stream.tty = tty;
            stream.seekable = false;
        },close:function (stream) {
            // flush any pending line data
            if (stream.tty.output.length) {
                stream.tty.ops.put_char(stream.tty, 10);
            }
        },read:function (stream, buffer, offset, length, pos /* ignored */) {
            if (!stream.tty || !stream.tty.ops.get_char) {
                throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
            }
            var bytesRead = 0;
            for (var i = 0; i < length; i++) {
                var result;
                try {
                    result = stream.tty.ops.get_char(stream.tty);
                } catch (e) {
                    throw new FS.ErrnoError(ERRNO_CODES.EIO);
                }
                if (result === undefined && bytesRead === 0) {
                    throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
                }
                if (result === null || result === undefined) break;
                bytesRead++;
                buffer[offset+i] = result;
            }
            if (bytesRead) {
                stream.node.timestamp = Date.now();
            }
            return bytesRead;
        },write:function (stream, buffer, offset, length, pos) {
            if (!stream.tty || !stream.tty.ops.put_char) {
                throw new FS.ErrnoError(ERRNO_CODES.ENXIO);
            }
            for (var i = 0; i < length; i++) {
                try {
                    stream.tty.ops.put_char(stream.tty, buffer[offset+i]);
                } catch (e) {
                    throw new FS.ErrnoError(ERRNO_CODES.EIO);
                }
            }
            if (length) {
                stream.node.timestamp = Date.now();
            }
            return i;
        }},default_tty_ops:{get_char:function (tty) {
            if (!tty.input.length) {
                var result = null;
                if (ENVIRONMENT_IS_NODE) {
                    result = process['stdin']['read']();
                    if (!result) {
                        if (process['stdin']['_readableState'] && process['stdin']['_readableState']['ended']) {
                            return null;  // EOF
                        }
                        return undefined;  // no data available
                    }
                } else if (typeof window != 'undefined' &&
                    typeof window.prompt == 'function') {
                    // Browser.
                    result = window.prompt('Input: ');  // returns null on cancel
                    if (result !== null) {
                        result += '\n';
                    }
                } else if (typeof readline == 'function') {
                    // Command line.
                    result = readline();
                    if (result !== null) {
                        result += '\n';
                    }
                }
                if (!result) {
                    return null;
                }
                tty.input = intArrayFromString(result, true);
            }
            return tty.input.shift();
        },put_char:function (tty, val) {
            if (val === null || val === 10) {
                Module['print'](tty.output.join(''));
                tty.output = [];
            } else {
                tty.output.push(TTY.utf8.processCChar(val));
            }
        }},default_tty1_ops:{put_char:function (tty, val) {
            if (val === null || val === 10) {
                Module['printErr'](tty.output.join(''));
                tty.output = [];
            } else {
                tty.output.push(TTY.utf8.processCChar(val));
            }
        }}};

var MEMFS={ops_table:null,CONTENT_OWNING:1,CONTENT_FLEXIBLE:2,CONTENT_FIXED:3,mount:function (mount) {
        return MEMFS.createNode(null, '/', 16384 | 511 /* 0777 */, 0);
    },createNode:function (parent, name, mode, dev) {
        if (FS.isBlkdev(mode) || FS.isFIFO(mode)) {
            // no supported
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (!MEMFS.ops_table) {
            MEMFS.ops_table = {
                dir: {
                    node: {
                        getattr: MEMFS.node_ops.getattr,
                        setattr: MEMFS.node_ops.setattr,
                        lookup: MEMFS.node_ops.lookup,
                        mknod: MEMFS.node_ops.mknod,
                        rename: MEMFS.node_ops.rename,
                        unlink: MEMFS.node_ops.unlink,
                        rmdir: MEMFS.node_ops.rmdir,
                        readdir: MEMFS.node_ops.readdir,
                        symlink: MEMFS.node_ops.symlink
                    },
                    stream: {
                        llseek: MEMFS.stream_ops.llseek
                    }
                },
                file: {
                    node: {
                        getattr: MEMFS.node_ops.getattr,
                        setattr: MEMFS.node_ops.setattr
                    },
                    stream: {
                        llseek: MEMFS.stream_ops.llseek,
                        read: MEMFS.stream_ops.read,
                        write: MEMFS.stream_ops.write,
                        allocate: MEMFS.stream_ops.allocate,
                        mmap: MEMFS.stream_ops.mmap
                    }
                },
                link: {
                    node: {
                        getattr: MEMFS.node_ops.getattr,
                        setattr: MEMFS.node_ops.setattr,
                        readlink: MEMFS.node_ops.readlink
                    },
                    stream: {}
                },
                chrdev: {
                    node: {
                        getattr: MEMFS.node_ops.getattr,
                        setattr: MEMFS.node_ops.setattr
                    },
                    stream: FS.chrdev_stream_ops
                },
            };
        }
        var node = FS.createNode(parent, name, mode, dev);
        if (FS.isDir(node.mode)) {
            node.node_ops = MEMFS.ops_table.dir.node;
            node.stream_ops = MEMFS.ops_table.dir.stream;
            node.contents = {};
        } else if (FS.isFile(node.mode)) {
            node.node_ops = MEMFS.ops_table.file.node;
            node.stream_ops = MEMFS.ops_table.file.stream;
            node.contents = [];
            node.contentMode = MEMFS.CONTENT_FLEXIBLE;
        } else if (FS.isLink(node.mode)) {
            node.node_ops = MEMFS.ops_table.link.node;
            node.stream_ops = MEMFS.ops_table.link.stream;
        } else if (FS.isChrdev(node.mode)) {
            node.node_ops = MEMFS.ops_table.chrdev.node;
            node.stream_ops = MEMFS.ops_table.chrdev.stream;
        }
        node.timestamp = Date.now();
        // add the new node to the parent
        if (parent) {
            parent.contents[name] = node;
        }
        return node;
    },ensureFlexible:function (node) {
        if (node.contentMode !== MEMFS.CONTENT_FLEXIBLE) {
            var contents = node.contents;
            node.contents = Array.prototype.slice.call(contents);
            node.contentMode = MEMFS.CONTENT_FLEXIBLE;
        }
    },node_ops:{getattr:function (node) {
            var attr = {};
            // device numbers reuse inode numbers.
            attr.dev = FS.isChrdev(node.mode) ? node.id : 1;
            attr.ino = node.id;
            attr.mode = node.mode;
            attr.nlink = 1;
            attr.uid = 0;
            attr.gid = 0;
            attr.rdev = node.rdev;
            if (FS.isDir(node.mode)) {
                attr.size = 4096;
            } else if (FS.isFile(node.mode)) {
                attr.size = node.contents.length;
            } else if (FS.isLink(node.mode)) {
                attr.size = node.link.length;
            } else {
                attr.size = 0;
            }
            attr.atime = new Date(node.timestamp);
            attr.mtime = new Date(node.timestamp);
            attr.ctime = new Date(node.timestamp);
            // NOTE: In our implementation, st_blocks = Math.ceil(st_size/st_blksize),
            //       but this is not required by the standard.
            attr.blksize = 4096;
            attr.blocks = Math.ceil(attr.size / attr.blksize);
            return attr;
        },setattr:function (node, attr) {
            if (attr.mode !== undefined) {
                node.mode = attr.mode;
            }
            if (attr.timestamp !== undefined) {
                node.timestamp = attr.timestamp;
            }
            if (attr.size !== undefined) {
                MEMFS.ensureFlexible(node);
                var contents = node.contents;
                if (attr.size < contents.length) contents.length = attr.size;
                else while (attr.size > contents.length) contents.push(0);
            }
        },lookup:function (parent, name) {
            throw FS.genericErrors[ERRNO_CODES.ENOENT];
        },mknod:function (parent, name, mode, dev) {
            return MEMFS.createNode(parent, name, mode, dev);
        },rename:function (old_node, new_dir, new_name) {
            // if we're overwriting a directory at new_name, make sure it's empty.
            if (FS.isDir(old_node.mode)) {
                var new_node;
                try {
                    new_node = FS.lookupNode(new_dir, new_name);
                } catch (e) {
                }
                if (new_node) {
                    for (var i in new_node.contents) {
                        throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
                    }
                }
            }
            // do the internal rewiring
            delete old_node.parent.contents[old_node.name];
            old_node.name = new_name;
            new_dir.contents[new_name] = old_node;
            old_node.parent = new_dir;
        },unlink:function (parent, name) {
            delete parent.contents[name];
        },rmdir:function (parent, name) {
            var node = FS.lookupNode(parent, name);
            for (var i in node.contents) {
                throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
            }
            delete parent.contents[name];
        },readdir:function (node) {
            var entries = ['.', '..']
            for (var key in node.contents) {
                if (!node.contents.hasOwnProperty(key)) {
                    continue;
                }
                entries.push(key);
            }
            return entries;
        },symlink:function (parent, newname, oldpath) {
            var node = MEMFS.createNode(parent, newname, 511 /* 0777 */ | 40960, 0);
            node.link = oldpath;
            return node;
        },readlink:function (node) {
            if (!FS.isLink(node.mode)) {
                throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
            }
            return node.link;
        }},stream_ops:{read:function (stream, buffer, offset, length, position) {
            var contents = stream.node.contents;
            if (position >= contents.length)
                return 0;
            var size = Math.min(contents.length - position, length);
            assert(size >= 0);
            if (size > 8 && contents.subarray) { // non-trivial, and typed array
                buffer.set(contents.subarray(position, position + size), offset);
            } else
            {
                for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents[position + i];
                }
            }
            return size;
        },write:function (stream, buffer, offset, length, position, canOwn) {
            var node = stream.node;
            node.timestamp = Date.now();
            var contents = node.contents;
            if (length && contents.length === 0 && position === 0 && buffer.subarray) {
                // just replace it with the new data
                if (canOwn && offset === 0) {
                    node.contents = buffer; // this could be a subarray of Emscripten HEAP, or allocated from some other source.
                    node.contentMode = (buffer.buffer === HEAP8.buffer) ? MEMFS.CONTENT_OWNING : MEMFS.CONTENT_FIXED;
                } else {
                    node.contents = new Uint8Array(buffer.subarray(offset, offset+length));
                    node.contentMode = MEMFS.CONTENT_FIXED;
                }
                return length;
            }
            MEMFS.ensureFlexible(node);
            var contents = node.contents;
            while (contents.length < position) contents.push(0);
            for (var i = 0; i < length; i++) {
                contents[position + i] = buffer[offset + i];
            }
            return length;
        },llseek:function (stream, offset, whence) {
            var position = offset;
            if (whence === 1) {  // SEEK_CUR.
                position += stream.position;
            } else if (whence === 2) {  // SEEK_END.
                if (FS.isFile(stream.node.mode)) {
                    position += stream.node.contents.length;
                }
            }
            if (position < 0) {
                throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
            }
            stream.ungotten = [];
            stream.position = position;
            return position;
        },allocate:function (stream, offset, length) {
            MEMFS.ensureFlexible(stream.node);
            var contents = stream.node.contents;
            var limit = offset + length;
            while (limit > contents.length) contents.push(0);
        },mmap:function (stream, buffer, offset, length, position, prot, flags) {
            if (!FS.isFile(stream.node.mode)) {
                throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
            }
            var ptr;
            var allocated;
            var contents = stream.node.contents;
            // Only make a new copy when MAP_PRIVATE is specified.
            if ( !(flags & 2) &&
                (contents.buffer === buffer || contents.buffer === buffer.buffer) ) {
                // We can't emulate MAP_SHARED when the file is not backed by the buffer
                // we're mapping to (e.g. the HEAP buffer).
                allocated = false;
                ptr = contents.byteOffset;
            } else {
                // Try to avoid unnecessary slices.
                if (position > 0 || position + length < contents.length) {
                    if (contents.subarray) {
                        contents = contents.subarray(position, position + length);
                    } else {
                        contents = Array.prototype.slice.call(contents, position, position + length);
                    }
                }
                allocated = true;
                ptr = _malloc(length);
                if (!ptr) {
                    throw new FS.ErrnoError(ERRNO_CODES.ENOMEM);
                }
                buffer.set(contents, ptr);
            }
            return { ptr: ptr, allocated: allocated };
        }}};

var IDBFS={dbs:{},indexedDB:function () {
        return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    },DB_VERSION:21,DB_STORE_NAME:"FILE_DATA",mount:function (mount) {
        // reuse all of the core MEMFS functionality
        return MEMFS.mount.apply(null, arguments);
    },syncfs:function (mount, populate, callback) {
        IDBFS.getLocalSet(mount, function(err, local) {
            if (err) return callback(err);

            IDBFS.getRemoteSet(mount, function(err, remote) {
                if (err) return callback(err);

                var src = populate ? remote : local;
                var dst = populate ? local : remote;

                IDBFS.reconcile(src, dst, callback);
            });
        });
    },getDB:function (name, callback) {
        // check the cache first
        var db = IDBFS.dbs[name];
        if (db) {
            return callback(null, db);
        }

        var req;
        try {
            req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION);
        } catch (e) {
            return callback(e);
        }
        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            var transaction = e.target.transaction;

            var fileStore;

            if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
                fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
            } else {
                fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
            }

            fileStore.createIndex('timestamp', 'timestamp', { unique: false });
        };
        req.onsuccess = function() {
            db = req.result;

            // add to the cache
            IDBFS.dbs[name] = db;
            callback(null, db);
        };
        req.onerror = function() {
            callback(this.error);
        };
    },getLocalSet:function (mount, callback) {
        var entries = {};

        function isRealDir(p) {
            return p !== '.' && p !== '..';
        };
        function toAbsolute(root) {
            return function(p) {
                return PATH.join2(root, p);
            }
        };

        var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));

        while (check.length) {
            var path = check.pop();
            var stat;

            try {
                stat = FS.stat(path);
            } catch (e) {
                return callback(e);
            }

            if (FS.isDir(stat.mode)) {
                check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
            }

            entries[path] = { timestamp: stat.mtime };
        }

        return callback(null, { type: 'local', entries: entries });
    },getRemoteSet:function (mount, callback) {
        var entries = {};

        IDBFS.getDB(mount.mountpoint, function(err, db) {
            if (err) return callback(err);

            var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readonly');
            transaction.onerror = function() { callback(this.error); };

            var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
            var index = store.index('timestamp');

            index.openKeyCursor().onsuccess = function(event) {
                var cursor = event.target.result;

                if (!cursor) {
                    return callback(null, { type: 'remote', db: db, entries: entries });
                }

                entries[cursor.primaryKey] = { timestamp: cursor.key };

                cursor.continue();
            };
        });
    },loadLocalEntry:function (path, callback) {
        var stat, node;

        try {
            var lookup = FS.lookupPath(path);
            node = lookup.node;
            stat = FS.stat(path);
        } catch (e) {
            return callback(e);
        }

        if (FS.isDir(stat.mode)) {
            return callback(null, { timestamp: stat.mtime, mode: stat.mode });
        } else if (FS.isFile(stat.mode)) {
            return callback(null, { timestamp: stat.mtime, mode: stat.mode, contents: node.contents });
        } else {
            return callback(new Error('node type not supported'));
        }
    },storeLocalEntry:function (path, entry, callback) {
        try {
            if (FS.isDir(entry.mode)) {
                FS.mkdir(path, entry.mode);
            } else if (FS.isFile(entry.mode)) {
                FS.writeFile(path, entry.contents, { encoding: 'binary', canOwn: true });
            } else {
                return callback(new Error('node type not supported'));
            }

            FS.utime(path, entry.timestamp, entry.timestamp);
        } catch (e) {
            return callback(e);
        }

        callback(null);
    },removeLocalEntry:function (path, callback) {
        try {
            var lookup = FS.lookupPath(path);
            var stat = FS.stat(path);

            if (FS.isDir(stat.mode)) {
                FS.rmdir(path);
            } else if (FS.isFile(stat.mode)) {
                FS.unlink(path);
            }
        } catch (e) {
            return callback(e);
        }

        callback(null);
    },loadRemoteEntry:function (store, path, callback) {
        var req = store.get(path);
        req.onsuccess = function(event) { callback(null, event.target.result); };
        req.onerror = function() { callback(this.error); };
    },storeRemoteEntry:function (store, path, entry, callback) {
        var req = store.put(entry, path);
        req.onsuccess = function() { callback(null); };
        req.onerror = function() { callback(this.error); };
    },removeRemoteEntry:function (store, path, callback) {
        var req = store.delete(path);
        req.onsuccess = function() { callback(null); };
        req.onerror = function() { callback(this.error); };
    },reconcile:function (src, dst, callback) {
        var total = 0;

        var create = [];
        Object.keys(src.entries).forEach(function (key) {
            var e = src.entries[key];
            var e2 = dst.entries[key];
            if (!e2 || e.timestamp > e2.timestamp) {
                create.push(key);
                total++;
            }
        });

        var remove = [];
        Object.keys(dst.entries).forEach(function (key) {
            var e = dst.entries[key];
            var e2 = src.entries[key];
            if (!e2) {
                remove.push(key);
                total++;
            }
        });

        if (!total) {
            return callback(null);
        }

        var errored = false;
        var completed = 0;
        var db = src.type === 'remote' ? src.db : dst.db;
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], 'readwrite');
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);

        function done(err) {
            if (err) {
                if (!done.errored) {
                    done.errored = true;
                    return callback(err);
                }
                return;
            }
            if (++completed >= total) {
                return callback(null);
            }
        };

        transaction.onerror = function() { done(this.error); };

        // sort paths in ascending order so directory entries are created
        // before the files inside them
        create.sort().forEach(function (path) {
            if (dst.type === 'local') {
                IDBFS.loadRemoteEntry(store, path, function (err, entry) {
                    if (err) return done(err);
                    IDBFS.storeLocalEntry(path, entry, done);
                });
            } else {
                IDBFS.loadLocalEntry(path, function (err, entry) {
                    if (err) return done(err);
                    IDBFS.storeRemoteEntry(store, path, entry, done);
                });
            }
        });

        // sort paths in descending order so files are deleted before their
        // parent directories
        remove.sort().reverse().forEach(function(path) {
            if (dst.type === 'local') {
                IDBFS.removeLocalEntry(path, done);
            } else {
                IDBFS.removeRemoteEntry(store, path, done);
            }
        });
    }};

var NODEFS={isWindows:false,staticInit:function () {
        NODEFS.isWindows = !!process.platform.match(/^win/);
    },mount:function (mount) {
        assert(ENVIRONMENT_IS_NODE);
        return NODEFS.createNode(null, '/', NODEFS.getMode(mount.opts.root), 0);
    },createNode:function (parent, name, mode, dev) {
        if (!FS.isDir(mode) && !FS.isFile(mode) && !FS.isLink(mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var node = FS.createNode(parent, name, mode);
        node.node_ops = NODEFS.node_ops;
        node.stream_ops = NODEFS.stream_ops;
        return node;
    },getMode:function (path) {
        var stat;
        try {
            stat = fs.lstatSync(path);
            if (NODEFS.isWindows) {
                // On Windows, directories return permission bits 'rw-rw-rw-', even though they have 'rwxrwxrwx', so
                // propagate write bits to execute bits.
                stat.mode = stat.mode | ((stat.mode & 146) >> 1);
            }
        } catch (e) {
            if (!e.code) throw e;
            throw new FS.ErrnoError(ERRNO_CODES[e.code]);
        }
        return stat.mode;
    },realPath:function (node) {
        var parts = [];
        while (node.parent !== node) {
            parts.push(node.name);
            node = node.parent;
        }
        parts.push(node.mount.opts.root);
        parts.reverse();
        return PATH.join.apply(null, parts);
    },flagsToPermissionStringMap:{0:"r",1:"r+",2:"r+",64:"r",65:"r+",66:"r+",129:"rx+",193:"rx+",514:"w+",577:"w",578:"w+",705:"wx",706:"wx+",1024:"a",1025:"a",1026:"a+",1089:"a",1090:"a+",1153:"ax",1154:"ax+",1217:"ax",1218:"ax+",4096:"rs",4098:"rs+"},flagsToPermissionString:function (flags) {
        if (flags in NODEFS.flagsToPermissionStringMap) {
            return NODEFS.flagsToPermissionStringMap[flags];
        } else {
            return flags;
        }
    },node_ops:{getattr:function (node) {
            var path = NODEFS.realPath(node);
            var stat;
            try {
                stat = fs.lstatSync(path);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
            // node.js v0.10.20 doesn't report blksize and blocks on Windows. Fake them with default blksize of 4096.
            // See http://support.microsoft.com/kb/140365
            if (NODEFS.isWindows && !stat.blksize) {
                stat.blksize = 4096;
            }
            if (NODEFS.isWindows && !stat.blocks) {
                stat.blocks = (stat.size+stat.blksize-1)/stat.blksize|0;
            }
            return {
                dev: stat.dev,
                ino: stat.ino,
                mode: stat.mode,
                nlink: stat.nlink,
                uid: stat.uid,
                gid: stat.gid,
                rdev: stat.rdev,
                size: stat.size,
                atime: stat.atime,
                mtime: stat.mtime,
                ctime: stat.ctime,
                blksize: stat.blksize,
                blocks: stat.blocks
            };
        },setattr:function (node, attr) {
            var path = NODEFS.realPath(node);
            try {
                if (attr.mode !== undefined) {
                    fs.chmodSync(path, attr.mode);
                    // update the common node structure mode as well
                    node.mode = attr.mode;
                }
                if (attr.timestamp !== undefined) {
                    var date = new Date(attr.timestamp);
                    fs.utimesSync(path, date, date);
                }
                if (attr.size !== undefined) {
                    fs.truncateSync(path, attr.size);
                }
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },lookup:function (parent, name) {
            var path = PATH.join2(NODEFS.realPath(parent), name);
            var mode = NODEFS.getMode(path);
            return NODEFS.createNode(parent, name, mode);
        },mknod:function (parent, name, mode, dev) {
            var node = NODEFS.createNode(parent, name, mode, dev);
            // create the backing node for this in the fs root as well
            var path = NODEFS.realPath(node);
            try {
                if (FS.isDir(node.mode)) {
                    fs.mkdirSync(path, node.mode);
                } else {
                    fs.writeFileSync(path, '', { mode: node.mode });
                }
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
            return node;
        },rename:function (oldNode, newDir, newName) {
            var oldPath = NODEFS.realPath(oldNode);
            var newPath = PATH.join2(NODEFS.realPath(newDir), newName);
            try {
                fs.renameSync(oldPath, newPath);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },unlink:function (parent, name) {
            var path = PATH.join2(NODEFS.realPath(parent), name);
            try {
                fs.unlinkSync(path);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },rmdir:function (parent, name) {
            var path = PATH.join2(NODEFS.realPath(parent), name);
            try {
                fs.rmdirSync(path);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },readdir:function (node) {
            var path = NODEFS.realPath(node);
            try {
                return fs.readdirSync(path);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },symlink:function (parent, newName, oldPath) {
            var newPath = PATH.join2(NODEFS.realPath(parent), newName);
            try {
                fs.symlinkSync(oldPath, newPath);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },readlink:function (node) {
            var path = NODEFS.realPath(node);
            try {
                return fs.readlinkSync(path);
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        }},stream_ops:{open:function (stream) {
            var path = NODEFS.realPath(stream.node);
            try {
                if (FS.isFile(stream.node.mode)) {
                    stream.nfd = fs.openSync(path, NODEFS.flagsToPermissionString(stream.flags));
                }
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },close:function (stream) {
            try {
                if (FS.isFile(stream.node.mode) && stream.nfd) {
                    fs.closeSync(stream.nfd);
                }
            } catch (e) {
                if (!e.code) throw e;
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
        },read:function (stream, buffer, offset, length, position) {
            // FIXME this is terrible.
            var nbuffer = new Buffer(length);
            var res;
            try {
                res = fs.readSync(stream.nfd, nbuffer, 0, length, position);
            } catch (e) {
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
            if (res > 0) {
                for (var i = 0; i < res; i++) {
                    buffer[offset + i] = nbuffer[i];
                }
            }
            return res;
        },write:function (stream, buffer, offset, length, position) {
            // FIXME this is terrible.
            var nbuffer = new Buffer(buffer.subarray(offset, offset + length));
            var res;
            try {
                res = fs.writeSync(stream.nfd, nbuffer, 0, length, position);
            } catch (e) {
                throw new FS.ErrnoError(ERRNO_CODES[e.code]);
            }
            return res;
        },llseek:function (stream, offset, whence) {
            var position = offset;
            if (whence === 1) {  // SEEK_CUR.
                position += stream.position;
            } else if (whence === 2) {  // SEEK_END.
                if (FS.isFile(stream.node.mode)) {
                    try {
                        var stat = fs.fstatSync(stream.nfd);
                        position += stat.size;
                    } catch (e) {
                        throw new FS.ErrnoError(ERRNO_CODES[e.code]);
                    }
                }
            }

            if (position < 0) {
                throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
            }

            stream.position = position;
            return position;
        }}};

var _stdin=allocate(1, "i32*", ALLOC_STATIC);

var _stdout=allocate(1, "i32*", ALLOC_STATIC);

var _stderr=allocate(1, "i32*", ALLOC_STATIC);

function _fflush(stream) {
    // int fflush(FILE *stream);
    // http://pubs.opengroup.org/onlinepubs/000095399/functions/fflush.html
    // we don't currently perform any user-space buffering of data
}var FS={root:null,mounts:[],devices:[null],streams:[],nextInode:1,nameTable:null,currentPath:"/",initialized:false,ignorePermissions:true,ErrnoError:null,genericErrors:{},handleFSError:function (e) {
        if (!(e instanceof FS.ErrnoError)) throw e + ' : ' + stackTrace();
        return ___setErrNo(e.errno);
    },lookupPath:function (path, opts) {
        path = PATH.resolve(FS.cwd(), path);
        opts = opts || {};

        var defaults = {
            follow_mount: true,
            recurse_count: 0
        };
        for (var key in defaults) {
            if (opts[key] === undefined) {
                opts[key] = defaults[key];
            }
        }

        if (opts.recurse_count > 8) {  // max recursive lookup of 8
            throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
        }

        // split the path
        var parts = PATH.normalizeArray(path.split('/').filter(function(p) {
            return !!p;
        }), false);

        // start at the root
        var current = FS.root;
        var current_path = '/';

        for (var i = 0; i < parts.length; i++) {
            var islast = (i === parts.length-1);
            if (islast && opts.parent) {
                // stop resolving
                break;
            }

            current = FS.lookupNode(current, parts[i]);
            current_path = PATH.join2(current_path, parts[i]);

            // jump to the mount's root node if this is a mountpoint
            if (FS.isMountpoint(current)) {
                if (!islast || (islast && opts.follow_mount)) {
                    current = current.mounted.root;
                }
            }

            // by default, lookupPath will not follow a symlink if it is the final path component.
            // setting opts.follow = true will override this behavior.
            if (!islast || opts.follow) {
                var count = 0;
                while (FS.isLink(current.mode)) {
                    var link = FS.readlink(current_path);
                    current_path = PATH.resolve(PATH.dirname(current_path), link);

                    var lookup = FS.lookupPath(current_path, { recurse_count: opts.recurse_count });
                    current = lookup.node;

                    if (count++ > 40) {  // limit max consecutive symlinks to 40 (SYMLOOP_MAX).
                        throw new FS.ErrnoError(ERRNO_CODES.ELOOP);
                    }
                }
            }
        }

        return { path: current_path, node: current };
    },getPath:function (node) {
        var path;
        while (true) {
            if (FS.isRoot(node)) {
                var mount = node.mount.mountpoint;
                if (!path) return mount;
                return mount[mount.length-1] !== '/' ? mount + '/' + path : mount + path;
            }
            path = path ? node.name + '/' + path : node.name;
            node = node.parent;
        }
    },hashName:function (parentid, name) {
        var hash = 0;


        for (var i = 0; i < name.length; i++) {
            hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
        }
        return ((parentid + hash) >>> 0) % FS.nameTable.length;
    },hashAddNode:function (node) {
        var hash = FS.hashName(node.parent.id, node.name);
        node.name_next = FS.nameTable[hash];
        FS.nameTable[hash] = node;
    },hashRemoveNode:function (node) {
        var hash = FS.hashName(node.parent.id, node.name);
        if (FS.nameTable[hash] === node) {
            FS.nameTable[hash] = node.name_next;
        } else {
            var current = FS.nameTable[hash];
            while (current) {
                if (current.name_next === node) {
                    current.name_next = node.name_next;
                    break;
                }
                current = current.name_next;
            }
        }
    },lookupNode:function (parent, name) {
        var err = FS.mayLookup(parent);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        var hash = FS.hashName(parent.id, name);
        for (var node = FS.nameTable[hash]; node; node = node.name_next) {
            var nodeName = node.name;
            if (node.parent.id === parent.id && nodeName === name) {
                return node;
            }
        }
        // if we failed to find it in the cache, call into the VFS
        return FS.lookup(parent, name);
    },createNode:function (parent, name, mode, rdev) {
        if (!FS.FSNode) {
            FS.FSNode = function(parent, name, mode, rdev) {
                if (!parent) {
                    parent = this;  // root node sets parent to itself
                }
                this.parent = parent;
                this.mount = parent.mount;
                this.mounted = null;
                this.id = FS.nextInode++;
                this.name = name;
                this.mode = mode;
                this.node_ops = {};
                this.stream_ops = {};
                this.rdev = rdev;
            };

            FS.FSNode.prototype = {};

            // compatibility
            var readMode = 292 | 73;
            var writeMode = 146;

            // NOTE we must use Object.defineProperties instead of individual calls to
            // Object.defineProperty in order to make closure compiler happy
            Object.defineProperties(FS.FSNode.prototype, {
                read: {
                    get: function() { return (this.mode & readMode) === readMode; },
                    set: function(val) { val ? this.mode |= readMode : this.mode &= ~readMode; }
                },
                write: {
                    get: function() { return (this.mode & writeMode) === writeMode; },
                    set: function(val) { val ? this.mode |= writeMode : this.mode &= ~writeMode; }
                },
                isFolder: {
                    get: function() { return FS.isDir(this.mode); },
                },
                isDevice: {
                    get: function() { return FS.isChrdev(this.mode); },
                },
            });
        }

        var node = new FS.FSNode(parent, name, mode, rdev);

        FS.hashAddNode(node);

        return node;
    },destroyNode:function (node) {
        FS.hashRemoveNode(node);
    },isRoot:function (node) {
        return node === node.parent;
    },isMountpoint:function (node) {
        return !!node.mounted;
    },isFile:function (mode) {
        return (mode & 61440) === 32768;
    },isDir:function (mode) {
        return (mode & 61440) === 16384;
    },isLink:function (mode) {
        return (mode & 61440) === 40960;
    },isChrdev:function (mode) {
        return (mode & 61440) === 8192;
    },isBlkdev:function (mode) {
        return (mode & 61440) === 24576;
    },isFIFO:function (mode) {
        return (mode & 61440) === 4096;
    },isSocket:function (mode) {
        return (mode & 49152) === 49152;
    },flagModes:{"r":0,"rs":1052672,"r+":2,"w":577,"wx":705,"xw":705,"w+":578,"wx+":706,"xw+":706,"a":1089,"ax":1217,"xa":1217,"a+":1090,"ax+":1218,"xa+":1218},modeStringToFlags:function (str) {
        var flags = FS.flagModes[str];
        if (typeof flags === 'undefined') {
            throw new Error('Unknown file open mode: ' + str);
        }
        return flags;
    },flagsToPermissionString:function (flag) {
        var accmode = flag & 2097155;
        var perms = ['r', 'w', 'rw'][accmode];
        if ((flag & 512)) {
            perms += 'w';
        }
        return perms;
    },nodePermissions:function (node, perms) {
        if (FS.ignorePermissions) {
            return 0;
        }
        // return 0 if any user, group or owner bits are set.
        if (perms.indexOf('r') !== -1 && !(node.mode & 292)) {
            return ERRNO_CODES.EACCES;
        } else if (perms.indexOf('w') !== -1 && !(node.mode & 146)) {
            return ERRNO_CODES.EACCES;
        } else if (perms.indexOf('x') !== -1 && !(node.mode & 73)) {
            return ERRNO_CODES.EACCES;
        }
        return 0;
    },mayLookup:function (dir) {
        return FS.nodePermissions(dir, 'x');
    },mayCreate:function (dir, name) {
        try {
            var node = FS.lookupNode(dir, name);
            return ERRNO_CODES.EEXIST;
        } catch (e) {
        }
        return FS.nodePermissions(dir, 'wx');
    },mayDelete:function (dir, name, isdir) {
        var node;
        try {
            node = FS.lookupNode(dir, name);
        } catch (e) {
            return e.errno;
        }
        var err = FS.nodePermissions(dir, 'wx');
        if (err) {
            return err;
        }
        if (isdir) {
            if (!FS.isDir(node.mode)) {
                return ERRNO_CODES.ENOTDIR;
            }
            if (FS.isRoot(node) || FS.getPath(node) === FS.cwd()) {
                return ERRNO_CODES.EBUSY;
            }
        } else {
            if (FS.isDir(node.mode)) {
                return ERRNO_CODES.EISDIR;
            }
        }
        return 0;
    },mayOpen:function (node, flags) {
        if (!node) {
            return ERRNO_CODES.ENOENT;
        }
        if (FS.isLink(node.mode)) {
            return ERRNO_CODES.ELOOP;
        } else if (FS.isDir(node.mode)) {
            if ((flags & 2097155) !== 0 ||  // opening for write
                (flags & 512)) {
                return ERRNO_CODES.EISDIR;
            }
        }
        return FS.nodePermissions(node, FS.flagsToPermissionString(flags));
    },MAX_OPEN_FDS:4096,nextfd:function (fd_start, fd_end) {
        fd_start = fd_start || 0;
        fd_end = fd_end || FS.MAX_OPEN_FDS;
        for (var fd = fd_start; fd <= fd_end; fd++) {
            if (!FS.streams[fd]) {
                return fd;
            }
        }
        throw new FS.ErrnoError(ERRNO_CODES.EMFILE);
    },getStream:function (fd) {
        return FS.streams[fd];
    },createStream:function (stream, fd_start, fd_end) {
        if (!FS.FSStream) {
            FS.FSStream = function(){};
            FS.FSStream.prototype = {};
            // compatibility
            Object.defineProperties(FS.FSStream.prototype, {
                object: {
                    get: function() { return this.node; },
                    set: function(val) { this.node = val; }
                },
                isRead: {
                    get: function() { return (this.flags & 2097155) !== 1; }
                },
                isWrite: {
                    get: function() { return (this.flags & 2097155) !== 0; }
                },
                isAppend: {
                    get: function() { return (this.flags & 1024); }
                }
            });
        }
        // clone it, so we can return an instance of FSStream
        var newStream = new FS.FSStream();
        for (var p in stream) {
            newStream[p] = stream[p];
        }
        stream = newStream;
        var fd = FS.nextfd(fd_start, fd_end);
        stream.fd = fd;
        FS.streams[fd] = stream;
        return stream;
    },closeStream:function (fd) {
        FS.streams[fd] = null;
    },getStreamFromPtr:function (ptr) {
        return FS.streams[ptr - 1];
    },getPtrForStream:function (stream) {
        return stream ? stream.fd + 1 : 0;
    },chrdev_stream_ops:{open:function (stream) {
            var device = FS.getDevice(stream.node.rdev);
            // override node's stream ops with the device's
            stream.stream_ops = device.stream_ops;
            // forward the open call
            if (stream.stream_ops.open) {
                stream.stream_ops.open(stream);
            }
        },llseek:function () {
            throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }},major:function (dev) {
        return ((dev) >> 8);
    },minor:function (dev) {
        return ((dev) & 0xff);
    },makedev:function (ma, mi) {
        return ((ma) << 8 | (mi));
    },registerDevice:function (dev, ops) {
        FS.devices[dev] = { stream_ops: ops };
    },getDevice:function (dev) {
        return FS.devices[dev];
    },getMounts:function (mount) {
        var mounts = [];
        var check = [mount];

        while (check.length) {
            var m = check.pop();

            mounts.push(m);

            check.push.apply(check, m.mounts);
        }

        return mounts;
    },syncfs:function (populate, callback) {
        if (typeof(populate) === 'function') {
            callback = populate;
            populate = false;
        }

        var mounts = FS.getMounts(FS.root.mount);
        var completed = 0;

        function done(err) {
            if (err) {
                if (!done.errored) {
                    done.errored = true;
                    return callback(err);
                }
                return;
            }
            if (++completed >= mounts.length) {
                callback(null);
            }
        };

        // sync all mounts
        mounts.forEach(function (mount) {
            if (!mount.type.syncfs) {
                return done(null);
            }
            mount.type.syncfs(mount, populate, done);
        });
    },mount:function (type, opts, mountpoint) {
        var root = mountpoint === '/';
        var pseudo = !mountpoint;
        var node;

        if (root && FS.root) {
            throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        } else if (!root && !pseudo) {
            var lookup = FS.lookupPath(mountpoint, { follow_mount: false });

            mountpoint = lookup.path;  // use the absolute path
            node = lookup.node;

            if (FS.isMountpoint(node)) {
                throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
            }

            if (!FS.isDir(node.mode)) {
                throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
            }
        }

        var mount = {
            type: type,
            opts: opts,
            mountpoint: mountpoint,
            mounts: []
        };

        // create a root node for the fs
        var mountRoot = type.mount(mount);
        mountRoot.mount = mount;
        mount.root = mountRoot;

        if (root) {
            FS.root = mountRoot;
        } else if (node) {
            // set as a mountpoint
            node.mounted = mount;

            // add the new mount to the current mount's children
            if (node.mount) {
                node.mount.mounts.push(mount);
            }
        }

        return mountRoot;
    },unmount:function (mountpoint) {
        var lookup = FS.lookupPath(mountpoint, { follow_mount: false });

        if (!FS.isMountpoint(lookup.node)) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }

        // destroy the nodes for this mount, and all its child mounts
        var node = lookup.node;
        var mount = node.mounted;
        var mounts = FS.getMounts(mount);

        Object.keys(FS.nameTable).forEach(function (hash) {
            var current = FS.nameTable[hash];

            while (current) {
                var next = current.name_next;

                if (mounts.indexOf(current.mount) !== -1) {
                    FS.destroyNode(current);
                }

                current = next;
            }
        });

        // no longer a mountpoint
        node.mounted = null;

        // remove this mount from the child mounts
        var idx = node.mount.mounts.indexOf(mount);
        assert(idx !== -1);
        node.mount.mounts.splice(idx, 1);
    },lookup:function (parent, name) {
        return parent.node_ops.lookup(parent, name);
    },mknod:function (path, mode, dev) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var err = FS.mayCreate(parent, name);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.mknod) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return parent.node_ops.mknod(parent, name, mode, dev);
    },create:function (path, mode) {
        mode = mode !== undefined ? mode : 438 /* 0666 */;
        mode &= 4095;
        mode |= 32768;
        return FS.mknod(path, mode, 0);
    },mkdir:function (path, mode) {
        mode = mode !== undefined ? mode : 511 /* 0777 */;
        mode &= 511 | 512;
        mode |= 16384;
        return FS.mknod(path, mode, 0);
    },mkdev:function (path, mode, dev) {
        if (typeof(dev) === 'undefined') {
            dev = mode;
            mode = 438 /* 0666 */;
        }
        mode |= 8192;
        return FS.mknod(path, mode, dev);
    },symlink:function (oldpath, newpath) {
        var lookup = FS.lookupPath(newpath, { parent: true });
        var parent = lookup.node;
        var newname = PATH.basename(newpath);
        var err = FS.mayCreate(parent, newname);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.symlink) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return parent.node_ops.symlink(parent, newname, oldpath);
    },rename:function (old_path, new_path) {
        var old_dirname = PATH.dirname(old_path);
        var new_dirname = PATH.dirname(new_path);
        var old_name = PATH.basename(old_path);
        var new_name = PATH.basename(new_path);
        // parents must exist
        var lookup, old_dir, new_dir;
        try {
            lookup = FS.lookupPath(old_path, { parent: true });
            old_dir = lookup.node;
            lookup = FS.lookupPath(new_path, { parent: true });
            new_dir = lookup.node;
        } catch (e) {
            throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        // need to be part of the same mount
        if (old_dir.mount !== new_dir.mount) {
            throw new FS.ErrnoError(ERRNO_CODES.EXDEV);
        }
        // source must exist
        var old_node = FS.lookupNode(old_dir, old_name);
        // old path should not be an ancestor of the new path
        var relative = PATH.relative(old_path, new_dirname);
        if (relative.charAt(0) !== '.') {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        // new path should not be an ancestor of the old path
        relative = PATH.relative(new_path, old_dirname);
        if (relative.charAt(0) !== '.') {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTEMPTY);
        }
        // see if the new path already exists
        var new_node;
        try {
            new_node = FS.lookupNode(new_dir, new_name);
        } catch (e) {
            // not fatal
        }
        // early out if nothing needs to change
        if (old_node === new_node) {
            return;
        }
        // we'll need to delete the old entry
        var isdir = FS.isDir(old_node.mode);
        var err = FS.mayDelete(old_dir, old_name, isdir);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        // need delete permissions if we'll be overwriting.
        // need create permissions if new doesn't already exist.
        err = new_node ?
            FS.mayDelete(new_dir, new_name, isdir) :
            FS.mayCreate(new_dir, new_name);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        if (!old_dir.node_ops.rename) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(old_node) || (new_node && FS.isMountpoint(new_node))) {
            throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        // if we are going to change the parent, check write permissions
        if (new_dir !== old_dir) {
            err = FS.nodePermissions(old_dir, 'w');
            if (err) {
                throw new FS.ErrnoError(err);
            }
        }
        // remove the node from the lookup hash
        FS.hashRemoveNode(old_node);
        // do the underlying fs rename
        try {
            old_dir.node_ops.rename(old_node, new_dir, new_name);
        } catch (e) {
            throw e;
        } finally {
            // add the node back to the hash (in case node_ops.rename
            // changed its name)
            FS.hashAddNode(old_node);
        }
    },rmdir:function (path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, true);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.rmdir) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        parent.node_ops.rmdir(parent, name);
        FS.destroyNode(node);
    },readdir:function (path) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        if (!node.node_ops.readdir) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
        }
        return node.node_ops.readdir(node);
    },unlink:function (path) {
        var lookup = FS.lookupPath(path, { parent: true });
        var parent = lookup.node;
        var name = PATH.basename(path);
        var node = FS.lookupNode(parent, name);
        var err = FS.mayDelete(parent, name, false);
        if (err) {
            // POSIX says unlink should set EPERM, not EISDIR
            if (err === ERRNO_CODES.EISDIR) err = ERRNO_CODES.EPERM;
            throw new FS.ErrnoError(err);
        }
        if (!parent.node_ops.unlink) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isMountpoint(node)) {
            throw new FS.ErrnoError(ERRNO_CODES.EBUSY);
        }
        parent.node_ops.unlink(parent, name);
        FS.destroyNode(node);
    },readlink:function (path) {
        var lookup = FS.lookupPath(path);
        var link = lookup.node;
        if (!link.node_ops.readlink) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        return link.node_ops.readlink(link);
    },stat:function (path, dontFollow) {
        var lookup = FS.lookupPath(path, { follow: !dontFollow });
        var node = lookup.node;
        if (!node.node_ops.getattr) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        return node.node_ops.getattr(node);
    },lstat:function (path) {
        return FS.stat(path, true);
    },chmod:function (path, mode, dontFollow) {
        var node;
        if (typeof path === 'string') {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node;
        } else {
            node = path;
        }
        if (!node.node_ops.setattr) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        node.node_ops.setattr(node, {
            mode: (mode & 4095) | (node.mode & ~4095),
            timestamp: Date.now()
        });
    },lchmod:function (path, mode) {
        FS.chmod(path, mode, true);
    },fchmod:function (fd, mode) {
        var stream = FS.getStream(fd);
        if (!stream) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        FS.chmod(stream.node, mode);
    },chown:function (path, uid, gid, dontFollow) {
        var node;
        if (typeof path === 'string') {
            var lookup = FS.lookupPath(path, { follow: !dontFollow });
            node = lookup.node;
        } else {
            node = path;
        }
        if (!node.node_ops.setattr) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        node.node_ops.setattr(node, {
            timestamp: Date.now()
            // we ignore the uid / gid for now
        });
    },lchown:function (path, uid, gid) {
        FS.chown(path, uid, gid, true);
    },fchown:function (fd, uid, gid) {
        var stream = FS.getStream(fd);
        if (!stream) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        FS.chown(stream.node, uid, gid);
    },truncate:function (path, len) {
        if (len < 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var node;
        if (typeof path === 'string') {
            var lookup = FS.lookupPath(path, { follow: true });
            node = lookup.node;
        } else {
            node = path;
        }
        if (!node.node_ops.setattr) {
            throw new FS.ErrnoError(ERRNO_CODES.EPERM);
        }
        if (FS.isDir(node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!FS.isFile(node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var err = FS.nodePermissions(node, 'w');
        if (err) {
            throw new FS.ErrnoError(err);
        }
        node.node_ops.setattr(node, {
            size: len,
            timestamp: Date.now()
        });
    },ftruncate:function (fd, len) {
        var stream = FS.getStream(fd);
        if (!stream) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if ((stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        FS.truncate(stream.node, len);
    },utime:function (path, atime, mtime) {
        var lookup = FS.lookupPath(path, { follow: true });
        var node = lookup.node;
        node.node_ops.setattr(node, {
            timestamp: Math.max(atime, mtime)
        });
    },open:function (path, flags, mode, fd_start, fd_end) {
        flags = typeof flags === 'string' ? FS.modeStringToFlags(flags) : flags;
        mode = typeof mode === 'undefined' ? 438 /* 0666 */ : mode;
        if ((flags & 64)) {
            mode = (mode & 4095) | 32768;
        } else {
            mode = 0;
        }
        var node;
        if (typeof path === 'object') {
            node = path;
        } else {
            path = PATH.normalize(path);
            try {
                var lookup = FS.lookupPath(path, {
                    follow: !(flags & 131072)
                });
                node = lookup.node;
            } catch (e) {
                // ignore
            }
        }
        // perhaps we need to create the node
        if ((flags & 64)) {
            if (node) {
                // if O_CREAT and O_EXCL are set, error out if the node already exists
                if ((flags & 128)) {
                    throw new FS.ErrnoError(ERRNO_CODES.EEXIST);
                }
            } else {
                // node doesn't exist, try to create it
                node = FS.mknod(path, mode, 0);
            }
        }
        if (!node) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOENT);
        }
        // can't truncate a device
        if (FS.isChrdev(node.mode)) {
            flags &= ~512;
        }
        // check permissions
        var err = FS.mayOpen(node, flags);
        if (err) {
            throw new FS.ErrnoError(err);
        }
        // do truncation if necessary
        if ((flags & 512)) {
            FS.truncate(node, 0);
        }
        // we've already handled these, don't pass down to the underlying vfs
        flags &= ~(128 | 512);

        // register the stream with the filesystem
        var stream = FS.createStream({
            node: node,
            path: FS.getPath(node),  // we want the absolute path to the node
            flags: flags,
            seekable: true,
            position: 0,
            stream_ops: node.stream_ops,
            // used by the file family libc calls (fopen, fwrite, ferror, etc.)
            ungotten: [],
            error: false
        }, fd_start, fd_end);
        // call the new stream's open function
        if (stream.stream_ops.open) {
            stream.stream_ops.open(stream);
        }
        if (Module['logReadFiles'] && !(flags & 1)) {
            if (!FS.readFiles) FS.readFiles = {};
            if (!(path in FS.readFiles)) {
                FS.readFiles[path] = 1;
                Module['printErr']('read file: ' + path);
            }
        }
        return stream;
    },close:function (stream) {
        try {
            if (stream.stream_ops.close) {
                stream.stream_ops.close(stream);
            }
        } catch (e) {
            throw e;
        } finally {
            FS.closeStream(stream.fd);
        }
    },llseek:function (stream, offset, whence) {
        if (!stream.seekable || !stream.stream_ops.llseek) {
            throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        return stream.stream_ops.llseek(stream, offset, whence);
    },read:function (stream, buffer, offset, length, position) {
        if (length < 0 || position < 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!stream.stream_ops.read) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var seeking = true;
        if (typeof position === 'undefined') {
            position = stream.position;
            seeking = false;
        } else if (!stream.seekable) {
            throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        var bytesRead = stream.stream_ops.read(stream, buffer, offset, length, position);
        if (!seeking) stream.position += bytesRead;
        return bytesRead;
    },write:function (stream, buffer, offset, length, position, canOwn) {
        if (length < 0 || position < 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (FS.isDir(stream.node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.EISDIR);
        }
        if (!stream.stream_ops.write) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        var seeking = true;
        if (typeof position === 'undefined') {
            position = stream.position;
            seeking = false;
        } else if (!stream.seekable) {
            throw new FS.ErrnoError(ERRNO_CODES.ESPIPE);
        }
        if (stream.flags & 1024) {
            // seek to the end before writing in append mode
            FS.llseek(stream, 0, 2);
        }
        var bytesWritten = stream.stream_ops.write(stream, buffer, offset, length, position, canOwn);
        if (!seeking) stream.position += bytesWritten;
        return bytesWritten;
    },allocate:function (stream, offset, length) {
        if (offset < 0 || length <= 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
        }
        if ((stream.flags & 2097155) === 0) {
            throw new FS.ErrnoError(ERRNO_CODES.EBADF);
        }
        if (!FS.isFile(stream.node.mode) && !FS.isDir(node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
        }
        if (!stream.stream_ops.allocate) {
            throw new FS.ErrnoError(ERRNO_CODES.EOPNOTSUPP);
        }
        stream.stream_ops.allocate(stream, offset, length);
    },mmap:function (stream, buffer, offset, length, position, prot, flags) {
        // TODO if PROT is PROT_WRITE, make sure we have write access
        if ((stream.flags & 2097155) === 1) {
            throw new FS.ErrnoError(ERRNO_CODES.EACCES);
        }
        if (!stream.stream_ops.mmap) {
            throw new FS.ErrnoError(ERRNO_CODES.ENODEV);
        }
        return stream.stream_ops.mmap(stream, buffer, offset, length, position, prot, flags);
    },ioctl:function (stream, cmd, arg) {
        if (!stream.stream_ops.ioctl) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTTY);
        }
        return stream.stream_ops.ioctl(stream, cmd, arg);
    },readFile:function (path, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'r';
        opts.encoding = opts.encoding || 'binary';
        if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
            throw new Error('Invalid encoding type "' + opts.encoding + '"');
        }
        var ret;
        var stream = FS.open(path, opts.flags);
        var stat = FS.stat(path);
        var length = stat.size;
        var buf = new Uint8Array(length);
        FS.read(stream, buf, 0, length, 0);
        if (opts.encoding === 'utf8') {
            ret = '';
            var utf8 = new Runtime.UTF8Processor();
            for (var i = 0; i < length; i++) {
                ret += utf8.processCChar(buf[i]);
            }
        } else if (opts.encoding === 'binary') {
            ret = buf;
        }
        FS.close(stream);
        return ret;
    },writeFile:function (path, data, opts) {
        opts = opts || {};
        opts.flags = opts.flags || 'w';
        opts.encoding = opts.encoding || 'utf8';
        if (opts.encoding !== 'utf8' && opts.encoding !== 'binary') {
            throw new Error('Invalid encoding type "' + opts.encoding + '"');
        }
        var stream = FS.open(path, opts.flags, opts.mode);
        if (opts.encoding === 'utf8') {
            var utf8 = new Runtime.UTF8Processor();
            var buf = new Uint8Array(utf8.processJSString(data));
            FS.write(stream, buf, 0, buf.length, 0, opts.canOwn);
        } else if (opts.encoding === 'binary') {
            FS.write(stream, data, 0, data.length, 0, opts.canOwn);
        }
        FS.close(stream);
    },cwd:function () {
        return FS.currentPath;
    },chdir:function (path) {
        var lookup = FS.lookupPath(path, { follow: true });
        if (!FS.isDir(lookup.node.mode)) {
            throw new FS.ErrnoError(ERRNO_CODES.ENOTDIR);
        }
        var err = FS.nodePermissions(lookup.node, 'x');
        if (err) {
            throw new FS.ErrnoError(err);
        }
        FS.currentPath = lookup.path;
    },createDefaultDirectories:function () {
        FS.mkdir('/tmp');
    },createDefaultDevices:function () {
        // create /dev
        FS.mkdir('/dev');
        // setup /dev/null
        FS.registerDevice(FS.makedev(1, 3), {
            read: function() { return 0; },
            write: function() { return 0; }
        });
        FS.mkdev('/dev/null', FS.makedev(1, 3));
        // setup /dev/tty and /dev/tty1
        // stderr needs to print output using Module['printErr']
        // so we register a second tty just for it.
        TTY.register(FS.makedev(5, 0), TTY.default_tty_ops);
        TTY.register(FS.makedev(6, 0), TTY.default_tty1_ops);
        FS.mkdev('/dev/tty', FS.makedev(5, 0));
        FS.mkdev('/dev/tty1', FS.makedev(6, 0));
        // we're not going to emulate the actual shm device,
        // just create the tmp dirs that reside in it commonly
        FS.mkdir('/dev/shm');
        FS.mkdir('/dev/shm/tmp');
    },createStandardStreams:function () {
        // TODO deprecate the old functionality of a single
        // input / output callback and that utilizes FS.createDevice
        // and instead require a unique set of stream ops

        // by default, we symlink the standard streams to the
        // default tty devices. however, if the standard streams
        // have been overwritten we create a unique device for
        // them instead.
        if (Module['stdin']) {
            FS.createDevice('/dev', 'stdin', Module['stdin']);
        } else {
            FS.symlink('/dev/tty', '/dev/stdin');
        }
        if (Module['stdout']) {
            FS.createDevice('/dev', 'stdout', null, Module['stdout']);
        } else {
            FS.symlink('/dev/tty', '/dev/stdout');
        }
        if (Module['stderr']) {
            FS.createDevice('/dev', 'stderr', null, Module['stderr']);
        } else {
            FS.symlink('/dev/tty1', '/dev/stderr');
        }

        // open default streams for the stdin, stdout and stderr devices
        var stdin = FS.open('/dev/stdin', 'r');
        HEAP32[((_stdin)>>2)]=FS.getPtrForStream(stdin);
        assert(stdin.fd === 0, 'invalid handle for stdin (' + stdin.fd + ')');

        var stdout = FS.open('/dev/stdout', 'w');
        HEAP32[((_stdout)>>2)]=FS.getPtrForStream(stdout);
        assert(stdout.fd === 1, 'invalid handle for stdout (' + stdout.fd + ')');

        var stderr = FS.open('/dev/stderr', 'w');
        HEAP32[((_stderr)>>2)]=FS.getPtrForStream(stderr);
        assert(stderr.fd === 2, 'invalid handle for stderr (' + stderr.fd + ')');
    },ensureErrnoError:function () {
        if (FS.ErrnoError) return;
        FS.ErrnoError = function ErrnoError(errno) {
            this.errno = errno;
            for (var key in ERRNO_CODES) {
                if (ERRNO_CODES[key] === errno) {
                    this.code = key;
                    break;
                }
            }
            this.message = ERRNO_MESSAGES[errno];
        };
        FS.ErrnoError.prototype = new Error();
        FS.ErrnoError.prototype.constructor = FS.ErrnoError;
        // Some errors may happen quite a bit, to avoid overhead we reuse them (and suffer a lack of stack info)
        [ERRNO_CODES.ENOENT].forEach(function(code) {
            FS.genericErrors[code] = new FS.ErrnoError(code);
            FS.genericErrors[code].stack = '<generic error, no stack>';
        });
    },staticInit:function () {
        FS.ensureErrnoError();

        FS.nameTable = new Array(4096);

        FS.mount(MEMFS, {}, '/');

        FS.createDefaultDirectories();
        FS.createDefaultDevices();
    },init:function (input, output, error) {
        assert(!FS.init.initialized, 'FS.init was previously called. If you want to initialize later with custom parameters, remove any earlier calls (note that one is automatically added to the generated code)');
        FS.init.initialized = true;

        FS.ensureErrnoError();

        // Allow Module.stdin etc. to provide defaults, if none explicitly passed to us here
        Module['stdin'] = input || Module['stdin'];
        Module['stdout'] = output || Module['stdout'];
        Module['stderr'] = error || Module['stderr'];

        FS.createStandardStreams();
    },quit:function () {
        FS.init.initialized = false;
        for (var i = 0; i < FS.streams.length; i++) {
            var stream = FS.streams[i];
            if (!stream) {
                continue;
            }
            FS.close(stream);
        }
    },getMode:function (canRead, canWrite) {
        var mode = 0;
        if (canRead) mode |= 292 | 73;
        if (canWrite) mode |= 146;
        return mode;
    },joinPath:function (parts, forceRelative) {
        var path = PATH.join.apply(null, parts);
        if (forceRelative && path[0] == '/') path = path.substr(1);
        return path;
    },absolutePath:function (relative, base) {
        return PATH.resolve(base, relative);
    },standardizePath:function (path) {
        return PATH.normalize(path);
    },findObject:function (path, dontResolveLastLink) {
        var ret = FS.analyzePath(path, dontResolveLastLink);
        if (ret.exists) {
            return ret.object;
        } else {
            ___setErrNo(ret.error);
            return null;
        }
    },analyzePath:function (path, dontResolveLastLink) {
        // operate from within the context of the symlink's target
        try {
            var lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            path = lookup.path;
        } catch (e) {
        }
        var ret = {
            isRoot: false, exists: false, error: 0, name: null, path: null, object: null,
            parentExists: false, parentPath: null, parentObject: null
        };
        try {
            var lookup = FS.lookupPath(path, { parent: true });
            ret.parentExists = true;
            ret.parentPath = lookup.path;
            ret.parentObject = lookup.node;
            ret.name = PATH.basename(path);
            lookup = FS.lookupPath(path, { follow: !dontResolveLastLink });
            ret.exists = true;
            ret.path = lookup.path;
            ret.object = lookup.node;
            ret.name = lookup.node.name;
            ret.isRoot = lookup.path === '/';
        } catch (e) {
            ret.error = e.errno;
        };
        return ret;
    },createFolder:function (parent, name, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.mkdir(path, mode);
    },createPath:function (parent, path, canRead, canWrite) {
        parent = typeof parent === 'string' ? parent : FS.getPath(parent);
        var parts = path.split('/').reverse();
        while (parts.length) {
            var part = parts.pop();
            if (!part) continue;
            var current = PATH.join2(parent, part);
            try {
                FS.mkdir(current);
            } catch (e) {
                // ignore EEXIST
            }
            parent = current;
        }
        return current;
    },createFile:function (parent, name, properties, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(canRead, canWrite);
        return FS.create(path, mode);
    },createDataFile:function (parent, name, data, canRead, canWrite, canOwn) {
        var path = name ? PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name) : parent;
        var mode = FS.getMode(canRead, canWrite);
        var node = FS.create(path, mode);
        if (data) {
            if (typeof data === 'string') {
                var arr = new Array(data.length);
                for (var i = 0, len = data.length; i < len; ++i) arr[i] = data.charCodeAt(i);
                data = arr;
            }
            // make sure we can write to the file
            FS.chmod(node, mode | 146);
            var stream = FS.open(node, 'w');
            FS.write(stream, data, 0, data.length, 0, canOwn);
            FS.close(stream);
            FS.chmod(node, mode);
        }
        return node;
    },createDevice:function (parent, name, input, output) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        var mode = FS.getMode(!!input, !!output);
        if (!FS.createDevice.major) FS.createDevice.major = 64;
        var dev = FS.makedev(FS.createDevice.major++, 0);
        // Create a fake device that a set of stream ops to emulate
        // the old behavior.
        FS.registerDevice(dev, {
            open: function(stream) {
                stream.seekable = false;
            },
            close: function(stream) {
                // flush any pending line data
                if (output && output.buffer && output.buffer.length) {
                    output(10);
                }
            },
            read: function(stream, buffer, offset, length, pos /* ignored */) {
                var bytesRead = 0;
                for (var i = 0; i < length; i++) {
                    var result;
                    try {
                        result = input();
                    } catch (e) {
                        throw new FS.ErrnoError(ERRNO_CODES.EIO);
                    }
                    if (result === undefined && bytesRead === 0) {
                        throw new FS.ErrnoError(ERRNO_CODES.EAGAIN);
                    }
                    if (result === null || result === undefined) break;
                    bytesRead++;
                    buffer[offset+i] = result;
                }
                if (bytesRead) {
                    stream.node.timestamp = Date.now();
                }
                return bytesRead;
            },
            write: function(stream, buffer, offset, length, pos) {
                for (var i = 0; i < length; i++) {
                    try {
                        output(buffer[offset+i]);
                    } catch (e) {
                        throw new FS.ErrnoError(ERRNO_CODES.EIO);
                    }
                }
                if (length) {
                    stream.node.timestamp = Date.now();
                }
                return i;
            }
        });
        return FS.mkdev(path, mode, dev);
    },createLink:function (parent, name, target, canRead, canWrite) {
        var path = PATH.join2(typeof parent === 'string' ? parent : FS.getPath(parent), name);
        return FS.symlink(target, path);
    },forceLoadFile:function (obj) {
        if (obj.isDevice || obj.isFolder || obj.link || obj.contents) return true;
        var success = true;
        if (typeof XMLHttpRequest !== 'undefined') {
            throw new Error("Lazy loading should have been performed (contents set) in createLazyFile, but it was not. Lazy loading only works in web workers. Use --embed-file or --preload-file in emcc on the main thread.");
        } else if (Module['read']) {
            // Command-line.
            try {
                // WARNING: Can't read binary files in V8's d8 or tracemonkey's js, as
                //          read() will try to parse UTF8.
                obj.contents = intArrayFromString(Module['read'](obj.url), true);
            } catch (e) {
                success = false;
            }
        } else {
            throw new Error('Cannot load without read() or XMLHttpRequest.');
        }
        if (!success) ___setErrNo(ERRNO_CODES.EIO);
        return success;
    },createLazyFile:function (parent, name, url, canRead, canWrite) {
        // Lazy chunked Uint8Array (implements get and length from Uint8Array). Actual getting is abstracted away for eventual reuse.
        function LazyUint8Array() {
            this.lengthKnown = false;
            this.chunks = []; // Loaded chunks. Index is the chunk number
        }
        LazyUint8Array.prototype.get = function LazyUint8Array_get(idx) {
            if (idx > this.length-1 || idx < 0) {
                return undefined;
            }
            var chunkOffset = idx % this.chunkSize;
            var chunkNum = Math.floor(idx / this.chunkSize);
            return this.getter(chunkNum)[chunkOffset];
        }
        LazyUint8Array.prototype.setDataGetter = function LazyUint8Array_setDataGetter(getter) {
            this.getter = getter;
        }
        LazyUint8Array.prototype.cacheLength = function LazyUint8Array_cacheLength() {
            // Find length
            var xhr = new XMLHttpRequest();
            xhr.open('HEAD', url, false);
            xhr.send(null);
            if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
            var datalength = Number(xhr.getResponseHeader("Content-length"));
            var header;
            var hasByteServing = (header = xhr.getResponseHeader("Accept-Ranges")) && header === "bytes";
            var chunkSize = 1024*1024; // Chunk size in bytes

            if (!hasByteServing) chunkSize = datalength;

            // Function to get a range from the remote URL.
            var doXHR = (function(from, to) {
                if (from > to) throw new Error("invalid range (" + from + ", " + to + ") or no bytes requested!");
                if (to > datalength-1) throw new Error("only " + datalength + " bytes available! programmer error!");

                // TODO: Use mozResponseArrayBuffer, responseStream, etc. if available.
                var xhr = new XMLHttpRequest();
                xhr.open('GET', url, false);
                if (datalength !== chunkSize) xhr.setRequestHeader("Range", "bytes=" + from + "-" + to);

                // Some hints to the browser that we want binary data.
                if (typeof Uint8Array != 'undefined') xhr.responseType = 'arraybuffer';
                if (xhr.overrideMimeType) {
                    xhr.overrideMimeType('text/plain; charset=x-user-defined');
                }

                xhr.send(null);
                if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) throw new Error("Couldn't load " + url + ". Status: " + xhr.status);
                if (xhr.response !== undefined) {
                    return new Uint8Array(xhr.response || []);
                } else {
                    return intArrayFromString(xhr.responseText || '', true);
                }
            });
            var lazyArray = this;
            lazyArray.setDataGetter(function(chunkNum) {
                var start = chunkNum * chunkSize;
                var end = (chunkNum+1) * chunkSize - 1; // including this byte
                end = Math.min(end, datalength-1); // if datalength-1 is selected, this is the last block
                if (typeof(lazyArray.chunks[chunkNum]) === "undefined") {
                    lazyArray.chunks[chunkNum] = doXHR(start, end);
                }
                if (typeof(lazyArray.chunks[chunkNum]) === "undefined") throw new Error("doXHR failed!");
                return lazyArray.chunks[chunkNum];
            });

            this._length = datalength;
            this._chunkSize = chunkSize;
            this.lengthKnown = true;
        }
        if (typeof XMLHttpRequest !== 'undefined') {
            if (!ENVIRONMENT_IS_WORKER) throw 'Cannot do synchronous binary XHRs outside webworkers in modern browsers. Use --embed-file or --preload-file in emcc';
            var lazyArray = new LazyUint8Array();
            Object.defineProperty(lazyArray, "length", {
                get: function() {
                    if(!this.lengthKnown) {
                        this.cacheLength();
                    }
                    return this._length;
                }
            });
            Object.defineProperty(lazyArray, "chunkSize", {
                get: function() {
                    if(!this.lengthKnown) {
                        this.cacheLength();
                    }
                    return this._chunkSize;
                }
            });

            var properties = { isDevice: false, contents: lazyArray };
        } else {
            var properties = { isDevice: false, url: url };
        }

        var node = FS.createFile(parent, name, properties, canRead, canWrite);
        // This is a total hack, but I want to get this lazy file code out of the
        // core of MEMFS. If we want to keep this lazy file concept I feel it should
        // be its own thin LAZYFS proxying calls to MEMFS.
        if (properties.contents) {
            node.contents = properties.contents;
        } else if (properties.url) {
            node.contents = null;
            node.url = properties.url;
        }
        // override each stream op with one that tries to force load the lazy file first
        var stream_ops = {};
        var keys = Object.keys(node.stream_ops);
        keys.forEach(function(key) {
            var fn = node.stream_ops[key];
            stream_ops[key] = function forceLoadLazyFile() {
                if (!FS.forceLoadFile(node)) {
                    throw new FS.ErrnoError(ERRNO_CODES.EIO);
                }
                return fn.apply(null, arguments);
            };
        });
        // use a custom read function
        stream_ops.read = function stream_ops_read(stream, buffer, offset, length, position) {
            if (!FS.forceLoadFile(node)) {
                throw new FS.ErrnoError(ERRNO_CODES.EIO);
            }
            var contents = stream.node.contents;
            if (position >= contents.length)
                return 0;
            var size = Math.min(contents.length - position, length);
            assert(size >= 0);
            if (contents.slice) { // normal array
                for (var i = 0; i < size; i++) {
                    buffer[offset + i] = contents[position + i];
                }
            } else {
                for (var i = 0; i < size; i++) { // LazyUint8Array from sync binary XHR
                    buffer[offset + i] = contents.get(position + i);
                }
            }
            return size;
        };
        node.stream_ops = stream_ops;
        return node;
    },createPreloadedFile:function (parent, name, url, canRead, canWrite, onload, onerror, dontCreateFile, canOwn) {
        Browser.init();
        // TODO we should allow people to just pass in a complete filename instead
        // of parent and name being that we just join them anyways
        var fullname = name ? PATH.resolve(PATH.join2(parent, name)) : parent;
        function processData(byteArray) {
            function finish(byteArray) {
                if (!dontCreateFile) {
                    FS.createDataFile(parent, name, byteArray, canRead, canWrite, canOwn);
                }
                if (onload) onload();
                removeRunDependency('cp ' + fullname);
            }
            var handled = false;
            Module['preloadPlugins'].forEach(function(plugin) {
                if (handled) return;
                if (plugin['canHandle'](fullname)) {
                    plugin['handle'](byteArray, fullname, finish, function() {
                        if (onerror) onerror();
                        removeRunDependency('cp ' + fullname);
                    });
                    handled = true;
                }
            });
            if (!handled) finish(byteArray);
        }
        addRunDependency('cp ' + fullname);
        if (typeof url == 'string') {
            Browser.asyncLoad(url, function(byteArray) {
                processData(byteArray);
            }, onerror);
        } else {
            processData(url);
        }
    },indexedDB:function () {
        return window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    },DB_NAME:function () {
        return 'EM_FS_' + window.location.pathname;
    },DB_VERSION:20,DB_STORE_NAME:"FILE_DATA",saveFilesToDB:function (paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
            var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
            return onerror(e);
        }
        openRequest.onupgradeneeded = function openRequest_onupgradeneeded() {
            console.log('creating db');
            var db = openRequest.result;
            db.createObjectStore(FS.DB_STORE_NAME);
        };
        openRequest.onsuccess = function openRequest_onsuccess() {
            var db = openRequest.result;
            var transaction = db.transaction([FS.DB_STORE_NAME], 'readwrite');
            var files = transaction.objectStore(FS.DB_STORE_NAME);
            var ok = 0, fail = 0, total = paths.length;
            function finish() {
                if (fail == 0) onload(); else onerror();
            }
            paths.forEach(function(path) {
                var putRequest = files.put(FS.analyzePath(path).object.contents, path);
                putRequest.onsuccess = function putRequest_onsuccess() { ok++; if (ok + fail == total) finish() };
                putRequest.onerror = function putRequest_onerror() { fail++; if (ok + fail == total) finish() };
            });
            transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
    },loadFilesFromDB:function (paths, onload, onerror) {
        onload = onload || function(){};
        onerror = onerror || function(){};
        var indexedDB = FS.indexedDB();
        try {
            var openRequest = indexedDB.open(FS.DB_NAME(), FS.DB_VERSION);
        } catch (e) {
            return onerror(e);
        }
        openRequest.onupgradeneeded = onerror; // no database to load from
        openRequest.onsuccess = function openRequest_onsuccess() {
            var db = openRequest.result;
            try {
                var transaction = db.transaction([FS.DB_STORE_NAME], 'readonly');
            } catch(e) {
                onerror(e);
                return;
            }
            var files = transaction.objectStore(FS.DB_STORE_NAME);
            var ok = 0, fail = 0, total = paths.length;
            function finish() {
                if (fail == 0) onload(); else onerror();
            }
            paths.forEach(function(path) {
                var getRequest = files.get(path);
                getRequest.onsuccess = function getRequest_onsuccess() {
                    if (FS.analyzePath(path).exists) {
                        FS.unlink(path);
                    }
                    FS.createDataFile(PATH.dirname(path), PATH.basename(path), getRequest.result, true, true, true);
                    ok++;
                    if (ok + fail == total) finish();
                };
                getRequest.onerror = function getRequest_onerror() { fail++; if (ok + fail == total) finish() };
            });
            transaction.onerror = onerror;
        };
        openRequest.onerror = onerror;
    }};var PATH={splitPath:function (filename) {
        var splitPathRe = /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
        return splitPathRe.exec(filename).slice(1);
    },normalizeArray:function (parts, allowAboveRoot) {
        // if the path tries to go above the root, `up` ends up > 0
        var up = 0;
        for (var i = parts.length - 1; i >= 0; i--) {
            var last = parts[i];
            if (last === '.') {
                parts.splice(i, 1);
            } else if (last === '..') {
                parts.splice(i, 1);
                up++;
            } else if (up) {
                parts.splice(i, 1);
                up--;
            }
        }
        // if the path is allowed to go above the root, restore leading ..s
        if (allowAboveRoot) {
            for (; up--; up) {
                parts.unshift('..');
            }
        }
        return parts;
    },normalize:function (path) {
        var isAbsolute = path.charAt(0) === '/',
            trailingSlash = path.substr(-1) === '/';
        // Normalize the path
        path = PATH.normalizeArray(path.split('/').filter(function(p) {
            return !!p;
        }), !isAbsolute).join('/');
        if (!path && !isAbsolute) {
            path = '.';
        }
        if (path && trailingSlash) {
            path += '/';
        }
        return (isAbsolute ? '/' : '') + path;
    },dirname:function (path) {
        var result = PATH.splitPath(path),
            root = result[0],
            dir = result[1];
        if (!root && !dir) {
            // No dirname whatsoever
            return '.';
        }
        if (dir) {
            // It has a dirname, strip trailing slash
            dir = dir.substr(0, dir.length - 1);
        }
        return root + dir;
    },basename:function (path) {
        // EMSCRIPTEN return '/'' for '/', not an empty string
        if (path === '/') return '/';
        var lastSlash = path.lastIndexOf('/');
        if (lastSlash === -1) return path;
        return path.substr(lastSlash+1);
    },extname:function (path) {
        return PATH.splitPath(path)[3];
    },join:function () {
        var paths = Array.prototype.slice.call(arguments, 0);
        return PATH.normalize(paths.join('/'));
    },join2:function (l, r) {
        return PATH.normalize(l + '/' + r);
    },resolve:function () {
        var resolvedPath = '',
            resolvedAbsolute = false;
        for (var i = arguments.length - 1; i >= -1 && !resolvedAbsolute; i--) {
            var path = (i >= 0) ? arguments[i] : FS.cwd();
            // Skip empty and invalid entries
            if (typeof path !== 'string') {
                throw new TypeError('Arguments to path.resolve must be strings');
            } else if (!path) {
                continue;
            }
            resolvedPath = path + '/' + resolvedPath;
            resolvedAbsolute = path.charAt(0) === '/';
        }
        // At this point the path should be resolved to a full absolute path, but
        // handle relative paths to be safe (might happen when process.cwd() fails)
        resolvedPath = PATH.normalizeArray(resolvedPath.split('/').filter(function(p) {
            return !!p;
        }), !resolvedAbsolute).join('/');
        return ((resolvedAbsolute ? '/' : '') + resolvedPath) || '.';
    },relative:function (from, to) {
        from = PATH.resolve(from).substr(1);
        to = PATH.resolve(to).substr(1);
        function trim(arr) {
            var start = 0;
            for (; start < arr.length; start++) {
                if (arr[start] !== '') break;
            }
            var end = arr.length - 1;
            for (; end >= 0; end--) {
                if (arr[end] !== '') break;
            }
            if (start > end) return [];
            return arr.slice(start, end - start + 1);
        }
        var fromParts = trim(from.split('/'));
        var toParts = trim(to.split('/'));
        var length = Math.min(fromParts.length, toParts.length);
        var samePartsLength = length;
        for (var i = 0; i < length; i++) {
            if (fromParts[i] !== toParts[i]) {
                samePartsLength = i;
                break;
            }
        }
        var outputParts = [];
        for (var i = samePartsLength; i < fromParts.length; i++) {
            outputParts.push('..');
        }
        outputParts = outputParts.concat(toParts.slice(samePartsLength));
        return outputParts.join('/');
    }};var Browser={mainLoop:{scheduler:null,method:"",shouldPause:false,paused:false,queue:[],pause:function () {
            Browser.mainLoop.shouldPause = true;
        },resume:function () {
            if (Browser.mainLoop.paused) {
                Browser.mainLoop.paused = false;
                Browser.mainLoop.scheduler();
            }
            Browser.mainLoop.shouldPause = false;
        },updateStatus:function () {
            if (Module['setStatus']) {
                var message = Module['statusMessage'] || 'Please wait...';
                var remaining = Browser.mainLoop.remainingBlockers;
                var expected = Browser.mainLoop.expectedBlockers;
                if (remaining) {
                    if (remaining < expected) {
                        Module['setStatus'](message + ' (' + (expected - remaining) + '/' + expected + ')');
                    } else {
                        Module['setStatus'](message);
                    }
                } else {
                    Module['setStatus']('');
                }
            }
        }},isFullScreen:false,pointerLock:false,moduleContextCreatedCallbacks:[],workers:[],init:function () {
        if (!Module["preloadPlugins"]) Module["preloadPlugins"] = []; // needs to exist even in workers

        if (Browser.initted || ENVIRONMENT_IS_WORKER) return;
        Browser.initted = true;

        try {
            new Blob();
            Browser.hasBlobConstructor = true;
        } catch(e) {
            Browser.hasBlobConstructor = false;
            console.log("warning: no blob constructor, cannot create blobs with mimetypes");
        }
        Browser.BlobBuilder = typeof MozBlobBuilder != "undefined" ? MozBlobBuilder : (typeof WebKitBlobBuilder != "undefined" ? WebKitBlobBuilder : (!Browser.hasBlobConstructor ? console.log("warning: no BlobBuilder") : null));
        Browser.URLObject = typeof window != "undefined" ? (window.URL ? window.URL : window.webkitURL) : undefined;
        if (!Module.noImageDecoding && typeof Browser.URLObject === 'undefined') {
            console.log("warning: Browser does not support creating object URLs. Built-in browser image decoding will not be available.");
            Module.noImageDecoding = true;
        }

        // Support for plugins that can process preloaded files. You can add more of these to
        // your app by creating and appending to Module.preloadPlugins.
        //
        // Each plugin is asked if it can handle a file based on the file's name. If it can,
        // it is given the file's raw data. When it is done, it calls a callback with the file's
        // (possibly modified) data. For example, a plugin might decompress a file, or it
        // might create some side data structure for use later (like an Image element, etc.).

        var imagePlugin = {};
        imagePlugin['canHandle'] = function imagePlugin_canHandle(name) {
            return !Module.noImageDecoding && /\.(jpg|jpeg|png|bmp)$/i.test(name);
        };
        imagePlugin['handle'] = function imagePlugin_handle(byteArray, name, onload, onerror) {
            var b = null;
            if (Browser.hasBlobConstructor) {
                try {
                    b = new Blob([byteArray], { type: Browser.getMimetype(name) });
                    if (b.size !== byteArray.length) { // Safari bug #118630
                        // Safari's Blob can only take an ArrayBuffer
                        b = new Blob([(new Uint8Array(byteArray)).buffer], { type: Browser.getMimetype(name) });
                    }
                } catch(e) {
                    Runtime.warnOnce('Blob constructor present but fails: ' + e + '; falling back to blob builder');
                }
            }
            if (!b) {
                var bb = new Browser.BlobBuilder();
                bb.append((new Uint8Array(byteArray)).buffer); // we need to pass a buffer, and must copy the array to get the right data range
                b = bb.getBlob();
            }
            var url = Browser.URLObject.createObjectURL(b);
            var img = new Image();
            img.onload = function img_onload() {
                assert(img.complete, 'Image ' + name + ' could not be decoded');
                var canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                var ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                Module["preloadedImages"][name] = canvas;
                Browser.URLObject.revokeObjectURL(url);
                if (onload) onload(byteArray);
            };
            img.onerror = function img_onerror(event) {
                console.log('Image ' + url + ' could not be decoded');
                if (onerror) onerror();
            };
            img.src = url;
        };
        Module['preloadPlugins'].push(imagePlugin);

        var audioPlugin = {};
        audioPlugin['canHandle'] = function audioPlugin_canHandle(name) {
            return !Module.noAudioDecoding && name.substr(-4) in { '.ogg': 1, '.wav': 1, '.mp3': 1 };
        };
        audioPlugin['handle'] = function audioPlugin_handle(byteArray, name, onload, onerror) {
            var done = false;
            function finish(audio) {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = audio;
                if (onload) onload(byteArray);
            }
            function fail() {
                if (done) return;
                done = true;
                Module["preloadedAudios"][name] = new Audio(); // empty shim
                if (onerror) onerror();
            }
            if (Browser.hasBlobConstructor) {
                try {
                    var b = new Blob([byteArray], { type: Browser.getMimetype(name) });
                } catch(e) {
                    return fail();
                }
                var url = Browser.URLObject.createObjectURL(b); // XXX we never revoke this!
                var audio = new Audio();
                audio.addEventListener('canplaythrough', function() { finish(audio) }, false); // use addEventListener due to chromium bug 124926
                audio.onerror = function audio_onerror(event) {
                    if (done) return;
                    console.log('warning: browser could not fully decode audio ' + name + ', trying slower base64 approach');
                    function encode64(data) {
                        var BASE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
                        var PAD = '=';
                        var ret = '';
                        var leftchar = 0;
                        var leftbits = 0;
                        for (var i = 0; i < data.length; i++) {
                            leftchar = (leftchar << 8) | data[i];
                            leftbits += 8;
                            while (leftbits >= 6) {
                                var curr = (leftchar >> (leftbits-6)) & 0x3f;
                                leftbits -= 6;
                                ret += BASE[curr];
                            }
                        }
                        if (leftbits == 2) {
                            ret += BASE[(leftchar&3) << 4];
                            ret += PAD + PAD;
                        } else if (leftbits == 4) {
                            ret += BASE[(leftchar&0xf) << 2];
                            ret += PAD;
                        }
                        return ret;
                    }
                    audio.src = 'data:audio/x-' + name.substr(-3) + ';base64,' + encode64(byteArray);
                    finish(audio); // we don't wait for confirmation this worked - but it's worth trying
                };
                audio.src = url;
                // workaround for chrome bug 124926 - we do not always get oncanplaythrough or onerror
                Browser.safeSetTimeout(function() {
                    finish(audio); // try to use it even though it is not necessarily ready to play
                }, 10000);
            } else {
                return fail();
            }
        };
        Module['preloadPlugins'].push(audioPlugin);

        // Canvas event setup

        var canvas = Module['canvas'];

        // forced aspect ratio can be enabled by defining 'forcedAspectRatio' on Module
        // Module['forcedAspectRatio'] = 4 / 3;

        canvas.requestPointerLock = canvas['requestPointerLock'] ||
            canvas['mozRequestPointerLock'] ||
            canvas['webkitRequestPointerLock'] ||
            canvas['msRequestPointerLock'] ||
            function(){};
        canvas.exitPointerLock = document['exitPointerLock'] ||
            document['mozExitPointerLock'] ||
            document['webkitExitPointerLock'] ||
            document['msExitPointerLock'] ||
            function(){}; // no-op if function does not exist
        canvas.exitPointerLock = canvas.exitPointerLock.bind(document);

        function pointerLockChange() {
            Browser.pointerLock = document['pointerLockElement'] === canvas ||
                document['mozPointerLockElement'] === canvas ||
                document['webkitPointerLockElement'] === canvas ||
                document['msPointerLockElement'] === canvas;
        }

        document.addEventListener('pointerlockchange', pointerLockChange, false);
        document.addEventListener('mozpointerlockchange', pointerLockChange, false);
        document.addEventListener('webkitpointerlockchange', pointerLockChange, false);
        document.addEventListener('mspointerlockchange', pointerLockChange, false);

        if (Module['elementPointerLock']) {
            canvas.addEventListener("click", function(ev) {
                if (!Browser.pointerLock && canvas.requestPointerLock) {
                    canvas.requestPointerLock();
                    ev.preventDefault();
                }
            }, false);
        }
    },createContext:function (canvas, useWebGL, setInModule, webGLContextAttributes) {
        var ctx;
        var errorInfo = '?';
        function onContextCreationError(event) {
            errorInfo = event.statusMessage || errorInfo;
        }
        try {
            if (useWebGL) {
                var contextAttributes = {
                    antialias: false,
                    alpha: false
                };

                if (webGLContextAttributes) {
                    for (var attribute in webGLContextAttributes) {
                        contextAttributes[attribute] = webGLContextAttributes[attribute];
                    }
                }


                canvas.addEventListener('webglcontextcreationerror', onContextCreationError, false);
                try {
                    ['experimental-webgl', 'webgl'].some(function(webglId) {
                        return ctx = canvas.getContext(webglId, contextAttributes);
                    });
                } finally {
                    canvas.removeEventListener('webglcontextcreationerror', onContextCreationError, false);
                }
            } else {
                ctx = canvas.getContext('2d');
            }
            if (!ctx) throw ':(';
        } catch (e) {
            Module.print('Could not create canvas: ' + [errorInfo, e]);
            return null;
        }
        if (useWebGL) {
            // Set the background of the WebGL canvas to black
            canvas.style.backgroundColor = "black";

            // Warn on context loss
            canvas.addEventListener('webglcontextlost', function(event) {
                alert('WebGL context lost. You will need to reload the page.');
            }, false);
        }
        if (setInModule) {
            GLctx = Module.ctx = ctx;
            Module.useWebGL = useWebGL;
            Browser.moduleContextCreatedCallbacks.forEach(function(callback) { callback() });
            Browser.init();
        }
        return ctx;
    },destroyContext:function (canvas, useWebGL, setInModule) {},fullScreenHandlersInstalled:false,lockPointer:undefined,resizeCanvas:undefined,requestFullScreen:function (lockPointer, resizeCanvas) {
        Browser.lockPointer = lockPointer;
        Browser.resizeCanvas = resizeCanvas;
        if (typeof Browser.lockPointer === 'undefined') Browser.lockPointer = true;
        if (typeof Browser.resizeCanvas === 'undefined') Browser.resizeCanvas = false;

        var canvas = Module['canvas'];
        function fullScreenChange() {
            Browser.isFullScreen = false;
            var canvasContainer = canvas.parentNode;
            if ((document['webkitFullScreenElement'] || document['webkitFullscreenElement'] ||
                document['mozFullScreenElement'] || document['mozFullscreenElement'] ||
                document['fullScreenElement'] || document['fullscreenElement'] ||
                document['msFullScreenElement'] || document['msFullscreenElement'] ||
                document['webkitCurrentFullScreenElement']) === canvasContainer) {
                canvas.cancelFullScreen = document['cancelFullScreen'] ||
                    document['mozCancelFullScreen'] ||
                    document['webkitCancelFullScreen'] ||
                    document['msExitFullscreen'] ||
                    document['exitFullscreen'] ||
                    function() {};
                canvas.cancelFullScreen = canvas.cancelFullScreen.bind(document);
                if (Browser.lockPointer) canvas.requestPointerLock();
                Browser.isFullScreen = true;
                if (Browser.resizeCanvas) Browser.setFullScreenCanvasSize();
            } else {

                // remove the full screen specific parent of the canvas again to restore the HTML structure from before going full screen
                canvasContainer.parentNode.insertBefore(canvas, canvasContainer);
                canvasContainer.parentNode.removeChild(canvasContainer);

                if (Browser.resizeCanvas) Browser.setWindowedCanvasSize();
            }
            if (Module['onFullScreen']) Module['onFullScreen'](Browser.isFullScreen);
            Browser.updateCanvasDimensions(canvas);
        }

        if (!Browser.fullScreenHandlersInstalled) {
            Browser.fullScreenHandlersInstalled = true;
            document.addEventListener('fullscreenchange', fullScreenChange, false);
            document.addEventListener('mozfullscreenchange', fullScreenChange, false);
            document.addEventListener('webkitfullscreenchange', fullScreenChange, false);
            document.addEventListener('MSFullscreenChange', fullScreenChange, false);
        }

        // create a new parent to ensure the canvas has no siblings. this allows browsers to optimize full screen performance when its parent is the full screen root
        var canvasContainer = document.createElement("div");
        canvas.parentNode.insertBefore(canvasContainer, canvas);
        canvasContainer.appendChild(canvas);

        // use parent of canvas as full screen root to allow aspect ratio correction (Firefox stretches the root to screen size)
        canvasContainer.requestFullScreen = canvasContainer['requestFullScreen'] ||
            canvasContainer['mozRequestFullScreen'] ||
            canvasContainer['msRequestFullscreen'] ||
            (canvasContainer['webkitRequestFullScreen'] ? function() { canvasContainer['webkitRequestFullScreen'](Element['ALLOW_KEYBOARD_INPUT']) } : null);
        canvasContainer.requestFullScreen();
    },requestAnimationFrame:function requestAnimationFrame(func) {
        if (typeof window === 'undefined') { // Provide fallback to setTimeout if window is undefined (e.g. in Node.js)
            setTimeout(func, 1000/60);
        } else {
            if (!window.requestAnimationFrame) {
                window.requestAnimationFrame = window['requestAnimationFrame'] ||
                    window['mozRequestAnimationFrame'] ||
                    window['webkitRequestAnimationFrame'] ||
                    window['msRequestAnimationFrame'] ||
                    window['oRequestAnimationFrame'] ||
                    window['setTimeout'];
            }
            window.requestAnimationFrame(func);
        }
    },safeCallback:function (func) {
        return function() {
            if (!ABORT) return func.apply(null, arguments);
        };
    },safeRequestAnimationFrame:function (func) {
        return Browser.requestAnimationFrame(function() {
            if (!ABORT) func();
        });
    },safeSetTimeout:function (func, timeout) {
        return setTimeout(function() {
            if (!ABORT) func();
        }, timeout);
    },safeSetInterval:function (func, timeout) {
        return setInterval(function() {
            if (!ABORT) func();
        }, timeout);
    },getMimetype:function (name) {
        return {
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'bmp': 'image/bmp',
            'ogg': 'audio/ogg',
            'wav': 'audio/wav',
            'mp3': 'audio/mpeg'
        }[name.substr(name.lastIndexOf('.')+1)];
    },getUserMedia:function (func) {
        if(!window.getUserMedia) {
            window.getUserMedia = navigator['getUserMedia'] ||
                navigator['mozGetUserMedia'];
        }
        window.getUserMedia(func);
    },getMovementX:function (event) {
        return event['movementX'] ||
            event['mozMovementX'] ||
            event['webkitMovementX'] ||
            0;
    },getMovementY:function (event) {
        return event['movementY'] ||
            event['mozMovementY'] ||
            event['webkitMovementY'] ||
            0;
    },getMouseWheelDelta:function (event) {
        return Math.max(-1, Math.min(1, event.type === 'DOMMouseScroll' ? event.detail : -event.wheelDelta));
    },mouseX:0,mouseY:0,mouseMovementX:0,mouseMovementY:0,touches:{},lastTouches:{},calculateMouseEvent:function (event) { // event should be mousemove, mousedown or mouseup
        if (Browser.pointerLock) {
            // When the pointer is locked, calculate the coordinates
            // based on the movement of the mouse.
            // Workaround for Firefox bug 764498
            if (event.type != 'mousemove' &&
                ('mozMovementX' in event)) {
                Browser.mouseMovementX = Browser.mouseMovementY = 0;
            } else {
                Browser.mouseMovementX = Browser.getMovementX(event);
                Browser.mouseMovementY = Browser.getMovementY(event);
            }

            // check if SDL is available
            if (typeof SDL != "undefined") {
                Browser.mouseX = SDL.mouseX + Browser.mouseMovementX;
                Browser.mouseY = SDL.mouseY + Browser.mouseMovementY;
            } else {
                // just add the mouse delta to the current absolut mouse position
                // FIXME: ideally this should be clamped against the canvas size and zero
                Browser.mouseX += Browser.mouseMovementX;
                Browser.mouseY += Browser.mouseMovementY;
            }
        } else {
            // Otherwise, calculate the movement based on the changes
            // in the coordinates.
            var rect = Module["canvas"].getBoundingClientRect();
            var cw = Module["canvas"].width;
            var ch = Module["canvas"].height;

            // Neither .scrollX or .pageXOffset are defined in a spec, but
            // we prefer .scrollX because it is currently in a spec draft.
            // (see: http://www.w3.org/TR/2013/WD-cssom-view-20131217/)
            var scrollX = ((typeof window.scrollX !== 'undefined') ? window.scrollX : window.pageXOffset);
            var scrollY = ((typeof window.scrollY !== 'undefined') ? window.scrollY : window.pageYOffset);

            if (event.type === 'touchstart' || event.type === 'touchend' || event.type === 'touchmove') {
                var touch = event.touch;
                if (touch === undefined) {
                    return; // the "touch" property is only defined in SDL

                }
                var adjustedX = touch.pageX - (scrollX + rect.left);
                var adjustedY = touch.pageY - (scrollY + rect.top);

                adjustedX = adjustedX * (cw / rect.width);
                adjustedY = adjustedY * (ch / rect.height);

                var coords = { x: adjustedX, y: adjustedY };

                if (event.type === 'touchstart') {
                    Browser.lastTouches[touch.identifier] = coords;
                    Browser.touches[touch.identifier] = coords;
                } else if (event.type === 'touchend' || event.type === 'touchmove') {
                    Browser.lastTouches[touch.identifier] = Browser.touches[touch.identifier];
                    Browser.touches[touch.identifier] = { x: adjustedX, y: adjustedY };
                }
                return;
            }

            var x = event.pageX - (scrollX + rect.left);
            var y = event.pageY - (scrollY + rect.top);

            // the canvas might be CSS-scaled compared to its backbuffer;
            // SDL-using content will want mouse coordinates in terms
            // of backbuffer units.
            x = x * (cw / rect.width);
            y = y * (ch / rect.height);

            Browser.mouseMovementX = x - Browser.mouseX;
            Browser.mouseMovementY = y - Browser.mouseY;
            Browser.mouseX = x;
            Browser.mouseY = y;
        }
    },xhrLoad:function (url, onload, onerror) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.responseType = 'arraybuffer';
        xhr.onload = function xhr_onload() {
            if (xhr.status == 200 || (xhr.status == 0 && xhr.response)) { // file URLs can return 0
                onload(xhr.response);
            } else {
                onerror();
            }
        };
        xhr.onerror = onerror;
        xhr.send(null);
    },asyncLoad:function (url, onload, onerror, noRunDep) {
        Browser.xhrLoad(url, function(arrayBuffer) {
            assert(arrayBuffer, 'Loading data file "' + url + '" failed (no arrayBuffer).');
            onload(new Uint8Array(arrayBuffer));
            if (!noRunDep) removeRunDependency('al ' + url);
        }, function(event) {
            if (onerror) {
                onerror();
            } else {
                throw 'Loading data file "' + url + '" failed.';
            }
        });
        if (!noRunDep) addRunDependency('al ' + url);
    },resizeListeners:[],updateResizeListeners:function () {
        var canvas = Module['canvas'];
        Browser.resizeListeners.forEach(function(listener) {
            listener(canvas.width, canvas.height);
        });
    },setCanvasSize:function (width, height, noUpdates) {
        var canvas = Module['canvas'];
        Browser.updateCanvasDimensions(canvas, width, height);
        if (!noUpdates) Browser.updateResizeListeners();
    },windowedWidth:0,windowedHeight:0,setFullScreenCanvasSize:function () {
        // check if SDL is available
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)];
            flags = flags | 0x00800000; // set SDL_FULLSCREEN flag
            HEAP32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)]=flags
        }
        Browser.updateResizeListeners();
    },setWindowedCanvasSize:function () {
        // check if SDL is available
        if (typeof SDL != "undefined") {
            var flags = HEAPU32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)];
            flags = flags & ~0x00800000; // clear SDL_FULLSCREEN flag
            HEAP32[((SDL.screen+Runtime.QUANTUM_SIZE*0)>>2)]=flags
        }
        Browser.updateResizeListeners();
    },updateCanvasDimensions:function (canvas, wNative, hNative) {
        if (wNative && hNative) {
            canvas.widthNative = wNative;
            canvas.heightNative = hNative;
        } else {
            wNative = canvas.widthNative;
            hNative = canvas.heightNative;
        }
        var w = wNative;
        var h = hNative;
        if (Module['forcedAspectRatio'] && Module['forcedAspectRatio'] > 0) {
            if (w/h < Module['forcedAspectRatio']) {
                w = Math.round(h * Module['forcedAspectRatio']);
            } else {
                h = Math.round(w / Module['forcedAspectRatio']);
            }
        }
        if (((document['webkitFullScreenElement'] || document['webkitFullscreenElement'] ||
            document['mozFullScreenElement'] || document['mozFullscreenElement'] ||
            document['fullScreenElement'] || document['fullscreenElement'] ||
            document['msFullScreenElement'] || document['msFullscreenElement'] ||
            document['webkitCurrentFullScreenElement']) === canvas.parentNode) && (typeof screen != 'undefined')) {
            var factor = Math.min(screen.width / w, screen.height / h);
            w = Math.round(w * factor);
            h = Math.round(h * factor);
        }
        if (Browser.resizeCanvas) {
            if (canvas.width  != w) canvas.width  = w;
            if (canvas.height != h) canvas.height = h;
            if (typeof canvas.style != 'undefined') {
                canvas.style.removeProperty( "width");
                canvas.style.removeProperty("height");
            }
        } else {
            if (canvas.width  != wNative) canvas.width  = wNative;
            if (canvas.height != hNative) canvas.height = hNative;
            if (typeof canvas.style != 'undefined') {
                if (w != wNative || h != hNative) {
                    canvas.style.setProperty( "width", w + "px", "important");
                    canvas.style.setProperty("height", h + "px", "important");
                } else {
                    canvas.style.removeProperty( "width");
                    canvas.style.removeProperty("height");
                }
            }
        }
    }};

function _sprintf(s, format, varargs) {
    // int sprintf(char *restrict s, const char *restrict format, ...);
    // http://pubs.opengroup.org/onlinepubs/000095399/functions/printf.html
    return _snprintf(s, undefined, format, varargs);
}

function _js_remove_solve_button() {
    document.getElementById("solve").style.display = "none";
}

function _js_dialog_init(titletext) {
    dialog_init(Pointer_stringify(titletext));
}

function _js_dialog_launch() {
    dialog_launch(function(event) {
        for (var i in dlg_return_funcs)
            dlg_return_funcs[i]();
        command(3);         // OK
    }, function(event) {
        command(4);         // Cancel
    });
}

function _js_add_preset_submenu(menuid, ptr, value) {
    var name = Pointer_stringify(ptr);
    var item = document.createElement("li");
    // We still create a transparent tick element, even though it
    // won't ever be selected, to make submenu titles line up
    // nicely with their neighbours.
    var tick = document.createElement("span");
    tick.appendChild(document.createTextNode("\u2713"));
    tick.style.color = "transparent";
    tick.style.paddingRight = "0.5em";
    item.appendChild(tick);
    item.appendChild(document.createTextNode(name));
    var submenu = document.createElement("ul");
    item.appendChild(submenu);
    gametypesubmenus[menuid].appendChild(item);
    var toret = gametypesubmenus.length;
    gametypesubmenus.push(submenu);
    return 0;//toret;
}

function _time(ptr) {
    var ret = Math.floor(Date.now()/1000);
    if (ptr) {
        HEAP32[((ptr)>>2)]=ret;
    }
    return ret;
}

function _copysign(a, b) {
    return __reallyNegative(a) === __reallyNegative(b) ? a : -a;
}

function _js_dialog_boolean(index, title, initvalue) {
    var checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "cb" + String(dlg_next_id++);
    checkbox.checked = (initvalue != 0);
    dlg_form.appendChild(checkbox);
    var checkboxlabel = document.createElement("label");
    checkboxlabel.setAttribute("for", checkbox.id);
    checkboxlabel.textContent = Pointer_stringify(title);
    dlg_form.appendChild(checkboxlabel);
    dlg_form.appendChild(document.createElement("br"));

    dlg_return_funcs.push(function() {
        dlg_return_ival(index, checkbox.checked ? 1 : 0);
    });
}

function _js_deactivate_timer() {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}

function _js_canvas_draw_line(x1, y1, x2, y2, width, colour) {
    colour = Pointer_stringify(colour);

    ctx.beginPath();
    ctx.moveTo(x1 + 0.5, y1 + 0.5);
    ctx.lineTo(x2 + 0.5, y2 + 0.5);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = colour;
    ctx.stroke();
    ctx.fillStyle = colour;
    ctx.fillRect(x1, y1, 1, 1);
    ctx.fillRect(x2, y2, 1, 1);
}

function _js_canvas_copy_to_blitter(id, x, y, w, h) {
    var blitter_ctx = blitters[id].getContext('2d');
    blitter_ctx.drawImage(offscreen_canvas,
        x, y, w, h,
        0, 0, w, h);
}

function _js_canvas_unclip() {
    ctx.restore();
}

function _js_error_box(ptr) {
    alert(Pointer_stringify(ptr));
}

var _atan2=Math_atan2;


Module["_strcpy"] = _strcpy;

var _copysignl=_copysign;

function _js_dialog_choices(index, title, choicelist, initvalue) {
    dlg_form.appendChild(document.createTextNode(Pointer_stringify(title)));
    var dropdown = document.createElement("select");
    var choicestr = Pointer_stringify(choicelist);
    var items = choicestr.slice(1).split(choicestr[0]);
    var options = [];
    for (var i in items) {
        var option = document.createElement("option");
        option.value = i;
        option.appendChild(document.createTextNode(items[i]));
        if (i == initvalue) option.selected = true;
        dropdown.appendChild(option);
        options.push(option);
    }
    dlg_form.appendChild(dropdown);
    dlg_form.appendChild(document.createElement("br"));

    dlg_return_funcs.push(function() {
        var val = 0;
        for (var i in options) {
            if (options[i].selected) {
                val = options[i].value;
                break;
            }
        }
        dlg_return_ival(index, val);
    });
}
___errno_state = Runtime.staticAlloc(4); HEAP32[((___errno_state)>>2)]=0;
___buildEnvironment(ENV);
Module["requestFullScreen"] = function Module_requestFullScreen(lockPointer, resizeCanvas) { Browser.requestFullScreen(lockPointer, resizeCanvas) };
Module["requestAnimationFrame"] = function Module_requestAnimationFrame(func) { Browser.requestAnimationFrame(func) };
Module["setCanvasSize"] = function Module_setCanvasSize(width, height, noUpdates) { Browser.setCanvasSize(width, height, noUpdates) };
Module["pauseMainLoop"] = function Module_pauseMainLoop() { Browser.mainLoop.pause() };
Module["resumeMainLoop"] = function Module_resumeMainLoop() { Browser.mainLoop.resume() };
Module["getUserMedia"] = function Module_getUserMedia() { Browser.getUserMedia() }
FS.staticInit();__ATINIT__.unshift({ func: function() { if (!Module["noFSInit"] && !FS.init.initialized) FS.init() } });__ATMAIN__.push({ func: function() { FS.ignorePermissions = false } });__ATEXIT__.push({ func: function() { FS.quit() } });Module["FS_createFolder"] = FS.createFolder;Module["FS_createPath"] = FS.createPath;Module["FS_createDataFile"] = FS.createDataFile;Module["FS_createPreloadedFile"] = FS.createPreloadedFile;Module["FS_createLazyFile"] = FS.createLazyFile;Module["FS_createLink"] = FS.createLink;Module["FS_createDevice"] = FS.createDevice;
__ATINIT__.unshift({ func: function() { TTY.init() } });__ATEXIT__.push({ func: function() { TTY.shutdown() } });TTY.utf8 = new Runtime.UTF8Processor();
if (ENVIRONMENT_IS_NODE) { var fs = require("fs"); NODEFS.staticInit(); }
STACK_BASE = STACKTOP = Runtime.alignMemory(STATICTOP);

staticSealed = true; // seal the static portion of memory

STACK_MAX = STACK_BASE + 5242880;

DYNAMIC_BASE = DYNAMICTOP = Runtime.alignMemory(STACK_MAX);

assert(DYNAMIC_BASE < TOTAL_MEMORY, "TOTAL_MEMORY not big enough for stack");

var ctlz_i8 = allocate([8,7,6,6,5,5,5,5,4,4,4,4,4,4,4,4,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,3,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], "i8", ALLOC_DYNAMIC);
var cttz_i8 = allocate([8,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,6,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,7,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,6,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,5,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0,4,0,1,0,2,0,1,0,3,0,1,0,2,0,1,0], "i8", ALLOC_DYNAMIC);

var Math_min = Math.min;
function invoke_iiiii(index,a1,a2,a3,a4) {
    try {
        return Module["dynCall_iiiii"](index,a1,a2,a3,a4);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viiiii(index,a1,a2,a3,a4,a5) {
    try {
        Module["dynCall_viiiii"](index,a1,a2,a3,a4,a5);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_i(index) {
    try {
        return Module["dynCall_i"](index);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_vi(index,a1) {
    try {
        Module["dynCall_vi"](index,a1);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_vii(index,a1,a2) {
    try {
        Module["dynCall_vii"](index,a1,a2);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_iiiiiii(index,a1,a2,a3,a4,a5,a6) {
    try {
        return Module["dynCall_iiiiiii"](index,a1,a2,a3,a4,a5,a6);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_vidddddi(index,a1,a2,a3,a4,a5,a6,a7) {
    try {
        Module["dynCall_vidddddi"](index,a1,a2,a3,a4,a5,a6,a7);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viiiiiidd(index,a1,a2,a3,a4,a5,a6,a7,a8) {
    try {
        Module["dynCall_viiiiiidd"](index,a1,a2,a3,a4,a5,a6,a7,a8);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_ii(index,a1) {
    try {
        return Module["dynCall_ii"](index,a1);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_iiii(index,a1,a2,a3) {
    try {
        return Module["dynCall_iiii"](index,a1,a2,a3);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viii(index,a1,a2,a3) {
    try {
        Module["dynCall_viii"](index,a1,a2,a3);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viiiiiiii(index,a1,a2,a3,a4,a5,a6,a7,a8) {
    try {
        Module["dynCall_viiiiiiii"](index,a1,a2,a3,a4,a5,a6,a7,a8);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viiiiii(index,a1,a2,a3,a4,a5,a6) {
    try {
        Module["dynCall_viiiiii"](index,a1,a2,a3,a4,a5,a6);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_iii(index,a1,a2) {
    try {
        return Module["dynCall_iii"](index,a1,a2);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_diiii(index,a1,a2,a3,a4) {
    try {
        return Module["dynCall_diiii"](index,a1,a2,a3,a4);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function invoke_viiii(index,a1,a2,a3,a4) {
    try {
        Module["dynCall_viiii"](index,a1,a2,a3,a4);
    } catch(e) {
        if (typeof e !== 'number' && e !== 'longjmp') throw e;
        asm["setThrew"](1, 0);
    }
}

function asmPrintInt(x, y) {
    Module.print('int ' + x + ',' + y);// + ' ' + new Error().stack);
}
function asmPrintFloat(x, y) {
    Module.print('float ' + x + ',' + y);// + ' ' + new Error().stack);
}
// EMSCRIPTEN_START_ASM
var asm=(function(global,env,buffer){"use asm";var a=new global.Int8Array(buffer);var b=new global.Int16Array(buffer);var c=new global.Int32Array(buffer);var d=new global.Uint8Array(buffer);var e=new global.Uint16Array(buffer);var f=new global.Uint32Array(buffer);var g=new global.Float32Array(buffer);var h=new global.Float64Array(buffer);var i=env.STACKTOP|0;var j=env.STACK_MAX|0;var k=env.tempDoublePtr|0;var l=env.ABORT|0;var m=env.cttz_i8|0;var n=env.ctlz_i8|0;var o=0;var p=0;var q=0;var r=0;var s=+env.NaN,t=+env.Infinity;var u=0,v=0,w=0,x=0,y=0.0,z=0,A=0,B=0,C=0.0;var D=0;var E=0;var F=0;var G=0;var H=0;var I=0;var J=0;var K=0;var L=0;var M=0;var N=global.Math.floor;var O=global.Math.abs;var P=global.Math.sqrt;var Q=global.Math.pow;var R=global.Math.cos;var S=global.Math.sin;var T=global.Math.tan;var U=global.Math.acos;var V=global.Math.asin;var W=global.Math.atan;var X=global.Math.atan2;var Y=global.Math.exp;var Z=global.Math.log;var _=global.Math.ceil;var $=global.Math.imul;var aa=env.abort;var ba=env.assert;var ca=env.asmPrintInt;var da=env.asmPrintFloat;var ea=env.min;var fa=env.invoke_iiiii;var ga=env.invoke_viiiii;var ha=env.invoke_i;var ia=env.invoke_vi;var ja=env.invoke_vii;var ka=env.invoke_iiiiiii;var la=env.invoke_vidddddi;var ma=env.invoke_viiiiiidd;var na=env.invoke_ii;var oa=env.invoke_iiii;var pa=env.invoke_viii;var qa=env.invoke_viiiiiiii;var ra=env.invoke_viiiiii;var sa=env.invoke_iii;var ta=env.invoke_diiii;var ua=env.invoke_viiii;var va=env._fabs;var wa=env._js_add_preset_submenu;var xa=env._js_error_box;var ya=env._js_dialog_cleanup;var za=env._js_select_preset;var Aa=env._js_dialog_init;var Ba=env._js_canvas_draw_line;var Ca=env._fmod;var Da=env._atan2;var Ea=env.__reallyNegative;var Fa=env._js_canvas_find_font_midpoint;var Ga=env.___assert_fail;var Ha=env.___buildEnvironment;var Ia=env._js_focus_canvas;var Ja=env._js_canvas_set_size;var Ka=env._js_dialog_launch;var La=env._js_canvas_draw_circle;var Ma=env._js_canvas_draw_rect;var Na=env._sscanf;var Oa=env._sbrk;var Pa=env._js_dialog_boolean;var Qa=env._js_canvas_new_blitter;var Ra=env._snprintf;var Sa=env.___errno_location;var Ta=env._emscripten_memcpy_big;var Ua=env._js_canvas_make_statusbar;var Va=env._js_canvas_set_statusbar;var Wa=env._sysconf;var Xa=env._js_canvas_unclip;var Ya=env.___setErrNo;var Za=env._js_canvas_draw_text;var _a=env._js_dialog_string;var $a=env._js_canvas_draw_update;var ab=env._js_update_permalinks;var bb=env._isspace;var cb=env._js_activate_timer;var db=env._js_remove_solve_button;var eb=env._getenv;var fb=env._sprintf;var gb=env._js_canvas_start_draw;var hb=env._js_add_preset;var ib=env._toupper;var jb=env._js_get_date_64;var kb=env._fflush;var lb=env.__scanString;var mb=env._js_deactivate_timer;var nb=env._vsnprintf;var ob=env._js_canvas_copy_from_blitter;var pb=env._copysign;var qb=env._js_canvas_end_draw;var rb=env.__getFloat;var sb=env._abort;var tb=env._js_dialog_choices;var ub=env._js_canvas_copy_to_blitter;var vb=env._time;var wb=env._isdigit;var xb=env._js_enable_undo_redo;var yb=env._abs;var zb=env.__formatString;var Ab=env._js_canvas_clip_rect;var Bb=env._sqrt;var Cb=env._js_canvas_draw_poly;var Db=env._js_canvas_free_blitter;var Eb=env._js_get_selected_preset;var Fb=0.0;
// EMSCRIPTEN_START_FUNCS
    function Wb(a){a=a|0;var b=0;b=i;i=i+a|0;i=i+7&-8;return b|0}function Xb(){return i|0}function Yb(a){a=a|0;i=a}function Zb(a,b){a=a|0;b=b|0;if((o|0)==0){o=a;p=b}}function _b(b){b=b|0;a[k]=a[b];a[k+1|0]=a[b+1|0];a[k+2|0]=a[b+2|0];a[k+3|0]=a[b+3|0]}function $b(b){b=b|0;a[k]=a[b];a[k+1|0]=a[b+1|0];a[k+2|0]=a[b+2|0];a[k+3|0]=a[b+3|0];a[k+4|0]=a[b+4|0];a[k+5|0]=a[b+5|0];a[k+6|0]=a[b+6|0];a[k+7|0]=a[b+7|0]}function ac(a){a=a|0;D=a}function bc(a){a=a|0;E=a}function cc(a){a=a|0;F=a}function dc(a){a=a|0;G=a}function ec(a){a=a|0;H=a}function fc(a){a=a|0;I=a}function gc(a){a=a|0;J=a}function hc(a){a=a|0;K=a}function ic(a){a=a|0;L=a}function jc(a){a=a|0;M=a}function kc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,h=0,j=0,k=0;e=i;i=i+16|0;f=e+12|0;h=e+8|0;j=e+4|0;k=e;c[f>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=me(32)|0;c[c[k>>2]>>2]=c[f>>2];c[(c[k>>2]|0)+4>>2]=c[j>>2];c[(c[k>>2]|0)+8>>2]=0;c[(c[k>>2]|0)+16>>2]=0;c[(c[k>>2]|0)+12>>2]=0;g[(c[k>>2]|0)+20>>2]=1.0;c[(c[k>>2]|0)+24>>2]=c[h>>2];c[(c[k>>2]|0)+28>>2]=0;i=e;return c[k>>2]|0}function lc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0;h=i;i=i+32|0;j=h+20|0;k=h+16|0;l=h+12|0;m=h+8|0;n=h+4|0;o=h;c[j>>2]=a;c[k>>2]=b;c[l>>2]=d;c[m>>2]=e;c[n>>2]=f;c[o>>2]=g;Sb[c[(c[c[j>>2]>>2]|0)+4>>2]&3](c[(c[j>>2]|0)+4>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0,c[n>>2]|0,c[o>>2]|0);i=h;return}function mc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0;h=i;i=i+32|0;j=h+20|0;k=h+16|0;l=h+12|0;m=h+8|0;n=h+4|0;o=h;c[j>>2]=a;c[k>>2]=b;c[l>>2]=d;c[m>>2]=e;c[n>>2]=f;c[o>>2]=g;Sb[c[(c[c[j>>2]>>2]|0)+8>>2]&3](c[(c[j>>2]|0)+4>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0,c[n>>2]|0,c[o>>2]|0);i=h;return}function nc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0;g=i;i=i+32|0;h=g+16|0;j=g+12|0;k=g+8|0;l=g+4|0;m=g;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;Hb[c[(c[c[h>>2]>>2]|0)+12>>2]&3](c[(c[h>>2]|0)+4>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0);i=g;return}function oc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0;h=i;i=i+32|0;j=h+20|0;k=h+16|0;l=h+12|0;m=h+8|0;n=h+4|0;o=h;c[j>>2]=a;c[k>>2]=b;c[l>>2]=d;c[m>>2]=e;c[n>>2]=f;c[o>>2]=g;Sb[c[(c[c[j>>2]>>2]|0)+16>>2]&3](c[(c[j>>2]|0)+4>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0,c[n>>2]|0,c[o>>2]|0);i=h;return}function pc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0;g=i;i=i+32|0;h=g+16|0;j=g+12|0;k=g+8|0;l=g+4|0;m=g;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;if((c[(c[c[h>>2]>>2]|0)+20>>2]|0)==0){i=g;return}Hb[c[(c[c[h>>2]>>2]|0)+20>>2]&3](c[(c[h>>2]|0)+4>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0);i=g;return}function qc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0;g=i;i=i+32|0;h=g+16|0;j=g+12|0;k=g+8|0;l=g+4|0;m=g;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;Hb[c[(c[c[h>>2]>>2]|0)+24>>2]&3](c[(c[h>>2]|0)+4>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0);i=g;return}function rc(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;Jb[c[(c[c[d>>2]>>2]|0)+28>>2]&7](c[(c[d>>2]|0)+4>>2]|0);i=b;return}function sc(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;Jb[c[(c[c[d>>2]>>2]|0)+32>>2]&7](c[(c[d>>2]|0)+4>>2]|0);i=b;return}function tc(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;Jb[c[(c[c[d>>2]>>2]|0)+36>>2]&7](c[(c[d>>2]|0)+4>>2]|0);i=b;return}function uc(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;if((c[(c[c[e>>2]>>2]|0)+40>>2]|0)==0){i=d;return}if((c[(c[e>>2]|0)+24>>2]|0)==0){Ga(24,8,200,32)}c[g>>2]=cf(c[(c[e>>2]|0)+24>>2]|0,c[f>>2]|0)|0;if((c[(c[e>>2]|0)+28>>2]|0)!=0?(Yf(c[g>>2]|0,c[(c[e>>2]|0)+28>>2]|0)|0)==0:0){ne(c[g>>2]|0);i=d;return}Kb[c[(c[c[e>>2]>>2]|0)+40>>2]&7](c[(c[e>>2]|0)+4>>2]|0,c[g>>2]|0);ne(c[(c[e>>2]|0)+28>>2]|0);c[(c[e>>2]|0)+28>>2]=c[g>>2];i=d;return}function vc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;d=Pb[c[(c[c[f>>2]>>2]|0)+44>>2]&7](c[(c[f>>2]|0)+4>>2]|0,c[g>>2]|0,c[h>>2]|0)|0;i=e;return d|0}function wc(a,b){a=a|0;b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;c[e>>2]=a;c[f>>2]=b;Kb[c[(c[c[e>>2]>>2]|0)+48>>2]&7](c[(c[e>>2]|0)+4>>2]|0,c[f>>2]|0);i=d;return}function xc(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0;f=i;i=i+16|0;g=f+12|0;h=f+8|0;j=f+4|0;k=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;Vb[c[(c[c[g>>2]>>2]|0)+52>>2]&7](c[(c[g>>2]|0)+4>>2]|0,c[h>>2]|0,c[j>>2]|0,c[k>>2]|0);i=f;return}function yc(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0;f=i;i=i+16|0;g=f+12|0;h=f+8|0;j=f+4|0;k=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;Vb[c[(c[c[g>>2]>>2]|0)+56>>2]&7](c[(c[g>>2]|0)+4>>2]|0,c[h>>2]|0,c[j>>2]|0,c[k>>2]|0);i=f;return}function zc(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=me(8)|0;jb(c[g>>2]|0);c[c[e>>2]>>2]=c[g>>2];c[c[f>>2]>>2]=8;i=d;return}function Ac(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+544|0;e=d+16|0;f=d+24|0;g=d;c[e>>2]=a;hg(f|0,48)|0;c[g>>2]=b;b=f+(dg(f|0)|0)|0;a=512-(dg(f|0)|0)|0;nb(b|0,a|0,c[e>>2]|0,g|0)|0;xa(f|0);i=d;return}function Bc(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[f>>2]=a;c[g>>2]=b;if((c[f>>2]|0)!=0?(c[g>>2]|0)!=0:0){c[e>>2]=Yf(c[f>>2]|0,c[g>>2]|0)|0;h=c[e>>2]|0;i=d;return h|0}if((c[f>>2]|0)!=0){j=1}else{j=(c[g>>2]|0)!=0?-1:0}c[e>>2]=j;h=c[e>>2]|0;i=d;return h|0}function Cc(b){b=b|0;var d=0;d=i;i=i+16|0;c[d>>2]=b;mb();a[72]=0;i=d;return}function Dc(b){b=b|0;var d=0;d=i;i=i+16|0;c[d>>2]=b;if(a[72]&1){i=d;return}cb();a[72]=1;i=d;return}function Ec(b){b=+b;var d=0,e=0;d=i;i=i+16|0;e=d;h[e>>3]=b;if(!(a[72]&1)){i=d;return}Ke(c[20]|0,+h[e>>3]);i=d;return}function Fc(a,b){a=a|0;b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;c[e>>2]=a;c[f>>2]=b;te(c[20]|0,e,f,1);if((c[22]|0)==(c[e>>2]|0)?(c[24]|0)==(c[f>>2]|0):0){i=d;return}Ja(c[e>>2]|0,c[f>>2]|0);c[22]=c[e>>2];c[24]=c[f>>2];we(c[20]|0);i=d;return}function Gc(a,b){a=a|0;b=b|0;var d=0;d=i;i=i+16|0;c[d+4>>2]=a;c[d>>2]=b;qe(c[20]|0);Hc();we(c[20]|0);i=d;return}function Hc(){var a=0,b=0,d=0;a=i;i=i+16|0;b=a+4|0;d=a;c[d>>2]=2147483647;c[b>>2]=2147483647;te(c[20]|0,b,d,0);Ja(c[b>>2]|0,c[d>>2]|0);c[22]=c[b>>2];c[24]=c[d>>2];i=a;return}function Ic(a,b){a=a|0;b=b|0;var d=0,e=0;d=i;i=i+16|0;e=d;c[d+4>>2]=a;c[e>>2]=b;g[(c[e>>2]|0)+8>>2]=.8999999761581421;g[(c[e>>2]|0)+4>>2]=.8999999761581421;g[c[e>>2]>>2]=.8999999761581421;i=d;return}function Jc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;if((c[h>>2]|0)==0){j=512}else{j=(c[h>>2]|0)==1?513:514}c[h>>2]=j;Ie(c[20]|0,c[f>>2]|0,c[g>>2]|0,c[h>>2]|0)|0;Kc();i=e;return}function Kc(){var a=0,b=0;a=i;b=Ee(c[20]|0)|0;xb(b|0,Fe(c[20]|0)|0);i=a;return}function Lc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;if((c[h>>2]|0)==0){j=518}else{j=(c[h>>2]|0)==1?519:520}c[h>>2]=j;Ie(c[20]|0,c[f>>2]|0,c[g>>2]|0,c[h>>2]|0)|0;Kc();i=e;return}function Mc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0;e=i;i=i+16|0;f=e+12|0;g=e+8|0;h=e+4|0;j=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;if((c[h>>2]&2|0)!=0){k=516}else{k=(c[h>>2]&4|0)!=0?517:515}c[j>>2]=k;Ie(c[20]|0,c[f>>2]|0,c[g>>2]|0,c[j>>2]|0)|0;Kc();i=e;return}function Nc(b,d,e,f,g,h){b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;var j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0;j=i;i=i+32|0;k=j+16|0;l=j+8|0;m=j+4|0;n=j+21|0;o=j+20|0;p=j;c[k>>2]=b;c[j+12>>2]=d;c[l>>2]=e;c[m>>2]=f;a[n]=g&1;a[o]=h&1;c[p>>2]=-1;do{if(((Bc(c[l>>2]|0,104)|0)!=0?(Bc(c[l>>2]|0,120)|0)!=0:0)?!((c[k>>2]|0)==8|(c[k>>2]|0)==46):0){if((Bc(c[l>>2]|0,128)|0)!=0?(c[k>>2]|0)!=13:0){if((Bc(c[l>>2]|0,136)|0)!=0?(c[k>>2]|0)!=37:0){if((Bc(c[l>>2]|0,144)|0)!=0?(c[k>>2]|0)!=38:0){if((Bc(c[l>>2]|0,152)|0)!=0?(c[k>>2]|0)!=39:0){if((Bc(c[l>>2]|0,160)|0)!=0?(c[k>>2]|0)!=40:0){if((Bc(c[l>>2]|0,168)|0)!=0?(c[k>>2]|0)!=35:0){if((Bc(c[l>>2]|0,176)|0)!=0?(c[k>>2]|0)!=34:0){if((Bc(c[l>>2]|0,192)|0)!=0?(c[k>>2]|0)!=36:0){if((Bc(c[l>>2]|0,200)|0)!=0?(c[k>>2]|0)!=33:0){if((a[n]&1?a[o]&1:0)?(c[k>>2]&31|0)==26:0){c[p>>2]=532;break}if(((c[m>>2]|0)!=0?(a[c[m>>2]|0]|0)!=0:0)?(a[(c[m>>2]|0)+1|0]|0)==0:0){c[p>>2]=a[c[m>>2]|0]&255;break}h=c[k>>2]|0;if((c[k>>2]|0)>=96&(c[k>>2]|0)<106){c[p>>2]=16384|48+h-96;break}g=c[k>>2]|0;if((h|0)>=65&(c[k>>2]|0)<=90){c[p>>2]=g+(a[n]&1?0:32);break}h=c[k>>2]|0;if((g|0)>=48&(c[k>>2]|0)<=57){c[p>>2]=h;break}if((h|0)!=32){break}c[p>>2]=c[k>>2];break}c[p>>2]=16441;break}c[p>>2]=16439;break}c[p>>2]=16435;break}c[p>>2]=16433;break}c[p>>2]=522;break}c[p>>2]=524;break}c[p>>2]=521;break}c[p>>2]=523;break}c[p>>2]=13}else{q=4}}while(0);if((q|0)==4){c[p>>2]=127}if((c[p>>2]|0)<0){i=j;return}if((a[n]&1?(c[p>>2]|0)>=256:0)?!((c[p>>2]|0)>527&(c[p>>2]|0)<533):0){c[p>>2]=c[p>>2]|8192}do{if(a[o]&1?!((c[p>>2]|0)>527&(c[p>>2]|0)<533):0){n=c[p>>2]|0;if((c[p>>2]|0)>=256){c[p>>2]=n|4096;break}else{c[p>>2]=n&31;break}}}while(0);Ie(c[20]|0,0,0,c[p>>2]|0)|0;Kc();i=j;return}function Oc(a,b,d,e,f,g,h,j){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;j=j|0;var k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0;k=i;i=i+128|0;l=k;m=k+36|0;n=k+32|0;o=k+28|0;p=k+24|0;q=k+20|0;r=k+16|0;s=k+12|0;t=k+48|0;u=k+8|0;c[k+40>>2]=a;c[m>>2]=b;c[n>>2]=d;c[o>>2]=e;c[p>>2]=f;c[q>>2]=g;c[r>>2]=h;c[s>>2]=j;j=(c[o>>2]|0)==0?560:576;c[l>>2]=c[p>>2];c[l+4>>2]=j;fb(t|0,552,l|0)|0;if((c[q>>2]&256|0)!=0){l=Fa(c[p>>2]|0,t|0)|0;c[n>>2]=(c[n>>2]|0)+l}do{if((c[q>>2]&1|0)==0){if((c[q>>2]&2|0)!=0){c[u>>2]=2;break}else{c[u>>2]=0;break}}else{c[u>>2]=1}}while(0);Za(c[m>>2]|0,c[n>>2]|0,c[u>>2]|0,c[(c[130]|0)+(c[r>>2]<<2)>>2]|0,t|0,c[s>>2]|0);i=k;return}function Pc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0;h=i;i=i+32|0;j=h+16|0;k=h+12|0;l=h+8|0;m=h+4|0;n=h;c[h+20>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;c[n>>2]=g;Ma(c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0,c[(c[130]|0)+(c[n>>2]<<2)>>2]|0);i=h;return}function Qc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0;h=i;i=i+32|0;j=h+16|0;k=h+12|0;l=h+8|0;m=h+4|0;n=h;c[h+20>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;c[n>>2]=g;Ba(+(+(c[j>>2]|0)),+(+(c[k>>2]|0)),+(+(c[l>>2]|0)),+(+(c[m>>2]|0)),1,c[(c[130]|0)+(c[n>>2]<<2)>>2]|0);i=h;return}function Rc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0;g=i;i=i+32|0;h=g+12|0;j=g+8|0;k=g+4|0;l=g;c[g+16>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=f;if((c[k>>2]|0)>=0){m=c[(c[130]|0)+(c[k>>2]<<2)>>2]|0}else{m=0}Cb(c[h>>2]|0,c[j>>2]|0,m|0,c[(c[130]|0)+(c[l>>2]<<2)>>2]|0);i=g;return}function Sc(a,b,d,e,f,g){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0;h=i;i=i+32|0;j=h+16|0;k=h+12|0;l=h+8|0;m=h+4|0;n=h;c[h+20>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;c[n>>2]=g;if((c[m>>2]|0)>=0){o=c[(c[130]|0)+(c[m>>2]<<2)>>2]|0}else{o=0}La(c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,o|0,c[(c[130]|0)+(c[n>>2]<<2)>>2]|0);i=h;return}function Tc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0;g=i;i=i+32|0;h=g+12|0;j=g+8|0;k=g+4|0;l=g;c[g+16>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=f;sd(h,j,k,l);if((c[k>>2]|0)<=0){i=g;return}if((c[l>>2]|0)<=0){i=g;return}$a(c[h>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0);i=g;return}function Uc(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0;g=i;i=i+32|0;h=g+12|0;j=g+8|0;k=g+4|0;l=g;c[g+16>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=f;Ab(c[h>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0);i=g;return}function Vc(a){a=a|0;var b=0;b=i;i=i+16|0;c[b>>2]=a;Xa();i=b;return}function Wc(a){a=a|0;var b=0;b=i;i=i+16|0;c[b>>2]=a;gb();i=b;return}function Xc(a){a=a|0;var b=0;b=i;i=i+16|0;c[b>>2]=a;qb();i=b;return}function Yc(a,b){a=a|0;b=b|0;var d=0,e=0;d=i;i=i+16|0;e=d;c[d+4>>2]=a;c[e>>2]=b;Va(c[e>>2]|0);i=d;return}function Zc(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[e+12>>2]=a;c[f>>2]=b;c[g>>2]=d;c[h>>2]=me(12)|0;c[(c[h>>2]|0)+4>>2]=c[f>>2];c[(c[h>>2]|0)+8>>2]=c[g>>2];d=Qa(c[f>>2]|0,c[g>>2]|0)|0;c[c[h>>2]>>2]=d;i=e;return c[h>>2]|0}function _c(a,b){a=a|0;b=b|0;var d=0,e=0;d=i;i=i+16|0;e=d;c[d+4>>2]=a;c[e>>2]=b;Db(c[c[e>>2]>>2]|0);ne(c[e>>2]|0);i=d;return}function $c(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0;f=i;i=i+32|0;g=f+16|0;h=f+12|0;j=f+8|0;k=f+4|0;l=f;c[f+20>>2]=a;c[g>>2]=b;c[h>>2]=d;c[j>>2]=e;c[k>>2]=c[(c[g>>2]|0)+4>>2];c[l>>2]=c[(c[g>>2]|0)+8>>2];sd(h,j,k,l);if((c[k>>2]|0)<=0){i=f;return}if((c[l>>2]|0)<=0){i=f;return}ub(c[c[g>>2]>>2]|0,c[h>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0);i=f;return}function ad(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0;f=i;i=i+32|0;g=f+16|0;h=f+12|0;j=f+8|0;k=f+4|0;l=f;c[f+20>>2]=a;c[g>>2]=b;c[h>>2]=d;c[j>>2]=e;c[k>>2]=c[(c[g>>2]|0)+4>>2];c[l>>2]=c[(c[g>>2]|0)+8>>2];sd(h,j,k,l);if((c[k>>2]|0)<=0){i=f;return}if((c[l>>2]|0)<=0){i=f;return}ob(c[c[g>>2]>>2]|0,c[h>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0);i=f;return}function bd(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0;e=i;i=i+16|0;f=e+4|0;c[e+8>>2]=a;c[f>>2]=b;c[e>>2]=d;d=pe(c[c[f>>2]>>2]|0)|0;i=e;return d|0}function cd(a,b,d,e,f,h,j){a=a|0;b=+b;d=+d;e=+e;f=+f;h=+h;j=j|0;var k=0,l=0,m=0,n=0,o=0,p=0,q=0;k=i;i=i+32|0;l=k+20|0;m=k+16|0;n=k+12|0;o=k+8|0;p=k+4|0;q=k;c[k+24>>2]=a;g[l>>2]=b;g[m>>2]=d;g[n>>2]=e;g[o>>2]=f;g[p>>2]=h;c[q>>2]=j;Ba(+(+g[m>>2]),+(+g[n>>2]),+(+g[o>>2]),+(+g[p>>2]),~~+g[l>>2]|0,c[(c[130]|0)+(c[q>>2]<<2)>>2]|0);i=k;return}function dd(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0;d=i;i=i+32|0;e=d+16|0;f=d+12|0;g=d+8|0;h=d+4|0;j=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=0;while(1){if((c[g>>2]|0)>=(c[c[f>>2]>>2]|0)){break}c[h>>2]=(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4);if((c[(c[h>>2]|0)+4>>2]|0)!=0){c[(c[78]|0)+(c[(c[h>>2]|0)+12>>2]<<2)>>2]=c[(c[h>>2]|0)+4>>2];hb(c[e>>2]|0,c[c[h>>2]>>2]|0,c[(c[h>>2]|0)+12>>2]|0)}else{c[j>>2]=wa(c[e>>2]|0,c[c[h>>2]>>2]|0)|0;dd(c[j>>2]|0,c[(c[h>>2]|0)+8>>2]|0)}c[g>>2]=(c[g>>2]|0)+1}i=d;return}function ed(){var b=0,d=0;b=i;i=i+16|0;d=b;if(!(a[320]&1)){i=b;return}c[d>>2]=Ue(c[20]|0)|0;za(((c[d>>2]|0)<0?-1:c[d>>2]|0)|0);i=b;return}function fd(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=(c[82]|0)+(c[e>>2]<<4);if((c[(c[g>>2]|0)+4>>2]|0)==0){ne(c[(c[g>>2]|0)+8>>2]|0);e=pe(c[f>>2]|0)|0;c[(c[g>>2]|0)+8>>2]=e;i=d;return}else{Ga(336,368,631,376)}}function gd(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=b;c[g>>2]=d;c[h>>2]=(c[82]|0)+(c[f>>2]<<4);f=c[(c[h>>2]|0)+4>>2]|0;if((f|0)==2){a[(c[h>>2]|0)+8|0]=(c[g>>2]|0)!=0|0;i=e;return}else if((f|0)==1){c[(c[h>>2]|0)+12>>2]=c[g>>2];i=e;return}else{Ga(392,368,645,424)}}function hd(b){b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=b;switch(c[e>>2]|0){case 1:{id(1);i=d;return};case 0:{id(2);i=d;return};case 2:{c[f>>2]=Eb()|0;if((c[f>>2]|0)<0){if(!(a[664|0]&1)){i=d;return}id(0);i=d;return}else{if((c[f>>2]|0)>=(c[110]|0)){Ga(448,368,729,464)}ve(c[20]|0,c[(c[78]|0)+(c[f>>2]<<2)>>2]|0);ye(c[20]|0);Hc();xe(c[20]|0);Kc();Ia();ed();i=d;return}break};case 3:{jd(1);Kc();i=d;return};case 4:{jd(0);Kc();i=d;return};case 5:{Ie(c[20]|0,0,0,529)|0;Kc();Ia();i=d;return};case 6:{He(c[20]|0);Kc();Ia();i=d;return};case 7:{Ie(c[20]|0,0,0,531)|0;Kc();Ia();i=d;return};case 8:{Ie(c[20]|0,0,0,532)|0;Kc();Ia();i=d;return};case 9:{if(a[700|0]&1?(c[g>>2]=bf(c[20]|0)|0,(c[g>>2]|0)!=0):0){xa(c[g>>2]|0)}Kc();Ia();i=d;return};default:{i=d;return}}}function id(b){b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=b;c[82]=Xe(c[20]|0,c[e>>2]|0,f)|0;c[136]=c[e>>2];Aa(c[f>>2]|0);ne(c[f>>2]|0);c[g>>2]=0;while(1){if((c[(c[82]|0)+(c[g>>2]<<4)+4>>2]|0)==3){break}f=c[(c[82]|0)+(c[g>>2]<<4)+4>>2]|0;if((f|0)==2){Pa(c[g>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)>>2]|0,a[(c[82]|0)+(c[g>>2]<<4)+8|0]&1|0)}else if((f|0)==1){tb(c[g>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)+8>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)+12>>2]|0)}else if((f|0)==0){_a(c[g>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)>>2]|0,c[(c[82]|0)+(c[g>>2]<<4)+8>>2]|0)}c[g>>2]=(c[g>>2]|0)+1}Ka();i=d;return}function jd(b){b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;a[e]=b&1;if(!(a[e]&1)){ed();kf(c[82]|0);ya();i=d;return}c[f>>2]=af(c[20]|0,c[136]|0,c[82]|0)|0;if((c[f>>2]|0)!=0){xa(c[f>>2]|0);i=d;return}else{ed();ye(c[20]|0);Hc();xe(c[20]|0);kf(c[82]|0);ya();i=d;return}}function kd(){var b=0,d=0,e=0;b=i;i=i+16|0;d=b+8|0;e=b;c[d>>2]=0;c[d+4>>2]=0;Ae(c[20]|0,4,d);c[e>>2]=c[d+4>>2];c[d>>2]=me((c[e>>2]|0)+1|0)|0;c[d+4>>2]=0;Ae(c[20]|0,4,d);if((c[d+4>>2]|0)==(c[e>>2]|0)){a[(c[d>>2]|0)+(c[d+4>>2]|0)|0]=0;i=b;return c[d>>2]|0}else{Ga(472,368,816,488)}return 0}function ld(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+16|0;f=e+12|0;g=e+8|0;h=e+4|0;j=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;c[j>>2]=c[f>>2];if((c[c[j>>2]>>2]|0)!=0){bg((c[c[j>>2]>>2]|0)+(c[(c[j>>2]|0)+4>>2]|0)|0,c[g>>2]|0,c[h>>2]|0)|0}g=(c[j>>2]|0)+4|0;c[g>>2]=(c[g>>2]|0)+(c[h>>2]|0);i=e;return}function md(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;ne(c[d>>2]|0);i=b;return}function nd(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0;d=i;i=i+32|0;e=d+20|0;f=d+16|0;g=d+8|0;h=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=c[e>>2];c[g+4>>2]=c[f>>2];c[h>>2]=df(c[20]|0,5,g)|0;if((c[h>>2]|0)!=0){xa(c[h>>2]|0);i=d;return}else{ed();Hc();xe(c[20]|0);i=d;return}}function od(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;f=i;i=i+32|0;g=f+16|0;h=f+12|0;j=f+8|0;k=f+4|0;l=f;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=c[h>>2];if((c[(c[l>>2]|0)+4>>2]|0)<(c[k>>2]|0)){a[g]=0;m=a[g]|0;n=m&1;i=f;return n|0}else{bg(c[j>>2]|0,c[c[l>>2]>>2]|0,c[k>>2]|0)|0;j=(c[l>>2]|0)+4|0;c[j>>2]=(c[j>>2]|0)-(c[k>>2]|0);j=c[l>>2]|0;c[j>>2]=(c[j>>2]|0)+(c[k>>2]|0);a[g]=1;m=a[g]|0;n=m&1;i=f;return n|0}return 0}function pd(b,d){b=b|0;d=d|0;var e=0,f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;e=i;i=i+80|0;f=e;h=e+32|0;j=e+28|0;k=e+24|0;l=e+20|0;m=e+16|0;n=e+12|0;o=e+40|0;c[e+36>>2]=0;c[h>>2]=b;c[j>>2]=d;c[20]=re(0,624,208,0)|0;if(((c[h>>2]|0)>1?(a[c[(c[j>>2]|0)+4>>2]|0]|0)==35:0)?(a[(c[(c[j>>2]|0)+4>>2]|0)+1|0]|0)!=0:0){c[k>>2]=Ye(c[20]|0,(c[(c[j>>2]|0)+4>>2]|0)+1|0)|0}else{c[k>>2]=0}ye(c[20]|0);Hc();if(Ve(c[20]|0)|0){Ua()}c[n>>2]=Qe(c[20]|0,440)|0;c[78]=me(c[110]<<2)|0;c[m>>2]=0;while(1){if((c[m>>2]|0)>=(c[110]|0)){break}c[(c[78]|0)+(c[m>>2]<<2)>>2]=0;c[m>>2]=(c[m>>2]|0)+1}dd(0,c[n>>2]|0);if(a[664|0]&1){hb(0,504,-1)}a[320]=1;ed();if(!(a[700|0]&1)){db()}c[l>>2]=Le(c[20]|0,512)|0;c[130]=me(c[128]<<2)|0;c[m>>2]=0;while(1){if((c[m>>2]|0)>=(c[128]|0)){break}n=~~(+g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+1<<2)>>2]*255.0+.5)>>>0;j=~~(+g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+2<<2)>>2]*255.0+.5)>>>0;c[f>>2]=~~(+g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+0<<2)>>2]*255.0+.5)>>>0;c[f+4>>2]=n;c[f+8>>2]=j;fb(o|0,528,f|0)|0;j=pe(o)|0;c[(c[130]|0)+(c[m>>2]<<2)>>2]=j;c[m>>2]=(c[m>>2]|0)+1}We(c[20]|0,7,0);xe(c[20]|0);rd();Kc();if((c[k>>2]|0)==0){i=e;return 0}xa(c[k>>2]|0);i=e;return 0}function qd(a){a=a|0;var b=0;b=i;i=i+16|0;c[b>>2]=a;rd();i=b;return}function rd(){var a=0,b=0,d=0;a=i;i=i+16|0;b=a+4|0;d=a;c[b>>2]=_e(c[20]|0)|0;c[d>>2]=$e(c[20]|0)|0;ab(c[b>>2]|0,c[d>>2]|0);ne(c[b>>2]|0);ne(c[d>>2]|0);i=a;return}function sd(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0;f=i;i=i+32|0;g=f+28|0;h=f+24|0;j=f+20|0;k=f+16|0;l=f+12|0;m=f+8|0;n=f+4|0;o=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=c[c[g>>2]>>2];c[n>>2]=c[c[h>>2]>>2];c[m>>2]=(c[c[g>>2]>>2]|0)+(c[c[j>>2]>>2]|0);c[o>>2]=(c[c[h>>2]>>2]|0)+(c[c[k>>2]>>2]|0);if((c[l>>2]|0)<0){p=0}else{p=(c[l>>2]|0)>(c[22]|0)?c[22]|0:c[l>>2]|0}c[l>>2]=p;if((c[m>>2]|0)<0){q=0}else{q=(c[m>>2]|0)>(c[22]|0)?c[22]|0:c[m>>2]|0}c[m>>2]=q;if((c[n>>2]|0)<0){r=0}else{r=(c[n>>2]|0)>(c[24]|0)?c[24]|0:c[n>>2]|0}c[n>>2]=r;if((c[o>>2]|0)<0){s=0}else{s=(c[o>>2]|0)>(c[24]|0)?c[24]|0:c[o>>2]|0}c[o>>2]=s;c[c[g>>2]>>2]=c[l>>2];c[c[h>>2]>>2]=c[n>>2];c[c[j>>2]>>2]=(c[m>>2]|0)-(c[l>>2]|0);c[c[k>>2]>>2]=(c[o>>2]|0)-(c[n>>2]|0);i=f;return}function td(){var a=0,b=0;a=i;i=i+16|0;b=a;c[b>>2]=me(8)|0;c[c[b>>2]>>2]=10;c[(c[b>>2]|0)+4>>2]=8;i=a;return c[b>>2]|0}function ud(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0;f=i;i=i+128|0;g=f;h=f+120|0;j=f+32|0;k=f+28|0;l=f+24|0;m=f+16|0;n=f+12|0;o=f+8|0;p=f+40|0;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;if((c[j>>2]|0)<0|(c[j>>2]|0)>>>0>=3){a[h]=0;q=a[h]|0;r=q&1;i=f;return r|0}else{e=2160+(c[j>>2]<<3)|0;c[m+0>>2]=c[e+0>>2];c[m+4>>2]=c[e+4>>2];c[n>>2]=yd(m)|0;m=c[(c[n>>2]|0)+4>>2]|0;c[g>>2]=c[c[n>>2]>>2];c[g+4>>2]=m;fb(p|0,2152,g|0)|0;c[o>>2]=pe(p)|0;c[c[l>>2]>>2]=c[n>>2];c[c[k>>2]>>2]=c[o>>2];a[h]=1;q=a[h]|0;r=q&1;i=f;return r|0}return 0}function vd(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0;f=i;i=i+16|0;g=f+4|0;h=f;c[g>>2]=b;c[h>>2]=e;e=Wf(c[h>>2]|0)|0;c[(c[g>>2]|0)+4>>2]=e;c[c[g>>2]>>2]=e;while(1){if((a[c[h>>2]|0]|0)!=0){j=(wb(d[c[h>>2]|0]|0)|0)!=0}else{j=0}k=c[h>>2]|0;if(!j){break}c[h>>2]=k+1}if((a[k]|0)!=120){i=f;return}c[h>>2]=(c[h>>2]|0)+1;k=Wf(c[h>>2]|0)|0;c[(c[g>>2]|0)+4>>2]=k;i=f;return}function wd(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+288|0;f=e;g=e+8|0;h=e+16|0;c[g>>2]=b;a[e+272|0]=d&1;d=c[(c[g>>2]|0)+4>>2]|0;c[f>>2]=c[c[g>>2]>>2];c[f+4>>2]=d;fb(h|0,2152,f|0)|0;f=pe(h)|0;i=e;return f|0}function xd(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;ne(c[d>>2]|0);i=b;return}function yd(a){a=a|0;var b=0,d=0,e=0,f=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;c[e>>2]=me(8)|0;a=c[e>>2]|0;f=c[d>>2]|0;c[a+0>>2]=c[f+0>>2];c[a+4>>2]=c[f+4>>2];i=b;return c[e>>2]|0}function zd(a){a=a|0;var b=0,d=0,e=0,f=0,g=0;b=i;i=i+96|0;d=b;e=b+8|0;f=b+4|0;g=b+16|0;c[e>>2]=a;c[f>>2]=me(48)|0;c[c[f>>2]>>2]=2136;c[(c[f>>2]|0)+4>>2]=0;c[d>>2]=c[c[e>>2]>>2];fb(g|0,1232,d|0)|0;a=pe(g)|0;c[(c[f>>2]|0)+8>>2]=a;c[(c[f>>2]|0)+16>>2]=2144;c[(c[f>>2]|0)+20>>2]=0;c[d>>2]=c[(c[e>>2]|0)+4>>2];fb(g|0,1232,d|0)|0;d=pe(g)|0;c[(c[f>>2]|0)+24>>2]=d;c[(c[f>>2]|0)+32>>2]=0;c[(c[f>>2]|0)+36>>2]=3;i=b;return c[f>>2]|0}function Ad(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;c[e>>2]=me(8)|0;a=Wf(c[(c[d>>2]|0)+8>>2]|0)|0;c[c[e>>2]>>2]=a;a=Wf(c[(c[d>>2]|0)+24>>2]|0)|0;c[(c[e>>2]|0)+4>>2]=a;i=b;return c[e>>2]|0}function Bd(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+4|0;g=e;c[g>>2]=b;a[e+8|0]=d&1;do{if((c[c[g>>2]>>2]|0)>=2?(c[(c[g>>2]|0)+4>>2]|0)>=2:0){if(($(c[c[g>>2]>>2]|0,c[(c[g>>2]|0)+4>>2]|0)|0)<6){c[f>>2]=2096;break}else{c[f>>2]=0;break}}else{h=3}}while(0);if((h|0)==3){c[f>>2]=2048}i=e;return c[f>>2]|0}function Cd(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0;g=i;i=i+16|0;h=g+8|0;j=g+4|0;c[h>>2]=b;c[j>>2]=d;c[g>>2]=e;a[g+12|0]=f&1;f=he(c[c[h>>2]>>2]|0,c[(c[h>>2]|0)+4>>2]|0,c[j>>2]|0)|0;i=g;return f|0}function Dd(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0;e=i;i=i+48|0;f=e+32|0;g=e+28|0;h=e+24|0;j=e+20|0;k=e+16|0;l=e+12|0;m=e+8|0;n=e+4|0;o=e;c[g>>2]=b;c[h>>2]=d;c[j>>2]=c[c[g>>2]>>2];c[k>>2]=c[(c[g>>2]|0)+4>>2];c[l>>2]=$(c[j>>2]|0,c[k>>2]|0)|0;c[m>>2]=0;c[n>>2]=0;c[o>>2]=0;while(1){p=(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=0;if((c[o>>2]|0)>=(c[l>>2]|0)){q=17;break}if(!p){q=4;break}if((((((a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=119?(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=83:0)?(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=115:0)?(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=103:0)?(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=109:0)?(a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)!=98:0){q=11;break}if((a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)==83){c[m>>2]=(c[m>>2]|0)+1}if((a[(c[h>>2]|0)+(c[o>>2]|0)|0]|0)==103){c[n>>2]=(c[n>>2]|0)+1}c[o>>2]=(c[o>>2]|0)+1}if((q|0)==4){c[f>>2]=1760;r=c[f>>2]|0;i=e;return r|0}else if((q|0)==11){c[f>>2]=1792;r=c[f>>2]|0;i=e;return r|0}else if((q|0)==17){if(p){c[f>>2]=1840;r=c[f>>2]|0;i=e;return r|0}if((c[m>>2]|0)<1){c[f>>2]=1872;r=c[f>>2]|0;i=e;return r|0}if((c[m>>2]|0)>1){c[f>>2]=1904;r=c[f>>2]|0;i=e;return r|0}if((c[n>>2]|0)<1){c[f>>2]=1944;r=c[f>>2]|0;i=e;return r|0}else{c[f>>2]=0;r=c[f>>2]|0;i=e;return r|0}}return 0}function Ed(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;f=i;i=i+32|0;g=f+24|0;h=f+20|0;j=f+16|0;k=f+12|0;l=f+8|0;m=f+4|0;n=f;c[f+28>>2]=b;c[g>>2]=d;c[h>>2]=e;c[j>>2]=c[c[g>>2]>>2];c[k>>2]=c[(c[g>>2]|0)+4>>2];c[l>>2]=$(c[j>>2]|0,c[k>>2]|0)|0;c[n>>2]=me(40)|0;k=c[n>>2]|0;e=c[g>>2]|0;c[k+0>>2]=c[e+0>>2];c[k+4>>2]=c[e+4>>2];e=me(c[l>>2]|0)|0;c[(c[n>>2]|0)+20>>2]=e;e=dg(c[h>>2]|0)|0;if((e|0)!=(c[l>>2]|0)){Ga(1664,840,625,1688)}bg(c[(c[n>>2]|0)+20>>2]|0,c[h>>2]|0,c[l>>2]|0)|0;c[(c[n>>2]|0)+12>>2]=-1;c[(c[n>>2]|0)+8>>2]=-1;c[(c[n>>2]|0)+16>>2]=0;c[m>>2]=0;while(1){if((c[m>>2]|0)>=(c[l>>2]|0)){break}h=(c[(c[n>>2]|0)+20>>2]|0)+(c[m>>2]|0)|0;if((a[(c[(c[n>>2]|0)+20>>2]|0)+(c[m>>2]|0)|0]|0)!=83){if((a[h]|0)==103){e=(c[n>>2]|0)+16|0;c[e>>2]=(c[e>>2]|0)+1}}else{a[h]=115;c[(c[n>>2]|0)+8>>2]=(c[m>>2]|0)%(c[j>>2]|0)|0;c[(c[n>>2]|0)+12>>2]=(c[m>>2]|0)/(c[j>>2]|0)|0}c[m>>2]=(c[m>>2]|0)+1}if((c[(c[n>>2]|0)+16>>2]|0)<=0){Ga(1704,840,640,1688)}if((c[(c[n>>2]|0)+8>>2]|0)<0){Ga(1720,840,641,1688)}if((c[(c[n>>2]|0)+12>>2]|0)>=0){c[(c[n>>2]|0)+24>>2]=0;a[(c[n>>2]|0)+28|0]=0;a[(c[n>>2]|0)+29|0]=0;c[(c[n>>2]|0)+32>>2]=0;c[(c[n>>2]|0)+36>>2]=0;i=f;return c[n>>2]|0}else{Ga(1720,840,641,1688)}return 0}function Fd(b){b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0;d=i;i=i+32|0;e=d+16|0;f=d+12|0;g=d+8|0;h=d+4|0;j=d;c[e>>2]=b;c[f>>2]=c[c[e>>2]>>2];c[g>>2]=c[(c[e>>2]|0)+4>>2];c[h>>2]=$(c[f>>2]|0,c[g>>2]|0)|0;c[j>>2]=me(40)|0;g=c[j>>2]|0;f=c[e>>2]|0;c[g+0>>2]=c[f+0>>2];c[g+4>>2]=c[f+4>>2];c[(c[j>>2]|0)+8>>2]=c[(c[e>>2]|0)+8>>2];c[(c[j>>2]|0)+12>>2]=c[(c[e>>2]|0)+12>>2];c[(c[j>>2]|0)+16>>2]=c[(c[e>>2]|0)+16>>2];f=me(c[h>>2]|0)|0;c[(c[j>>2]|0)+20>>2]=f;c[(c[j>>2]|0)+24>>2]=c[(c[e>>2]|0)+24>>2];a[(c[j>>2]|0)+28|0]=0;bg(c[(c[j>>2]|0)+20>>2]|0,c[(c[e>>2]|0)+20>>2]|0,c[h>>2]|0)|0;a[(c[j>>2]|0)+29|0]=a[(c[e>>2]|0)+29|0]&1;c[(c[j>>2]|0)+36>>2]=c[(c[e>>2]|0)+36>>2];if((c[(c[j>>2]|0)+36>>2]|0)==0){k=c[e>>2]|0;l=k+32|0;m=c[l>>2]|0;n=c[j>>2]|0;o=n+32|0;c[o>>2]=m;p=c[j>>2]|0;i=d;return p|0}h=c[(c[j>>2]|0)+36>>2]|0;c[h>>2]=(c[h>>2]|0)+1;k=c[e>>2]|0;l=k+32|0;m=c[l>>2]|0;n=c[j>>2]|0;o=n+32|0;c[o>>2]=m;p=c[j>>2]|0;i=d;return p|0}function Gd(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+36>>2]|0)!=0?(a=c[(c[d>>2]|0)+36>>2]|0,e=(c[a>>2]|0)+ -1|0,c[a>>2]=e,(e|0)==0):0){ne(c[(c[(c[d>>2]|0)+36>>2]|0)+8>>2]|0);ne(c[(c[d>>2]|0)+36>>2]|0)}ne(c[(c[d>>2]|0)+20>>2]|0);ne(c[d>>2]|0);i=b;return}function Hd(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,aa=0,ba=0,ca=0,da=0,ea=0,fa=0,ga=0,ha=0,ia=0,ja=0,ka=0,la=0,ma=0,na=0,oa=0,pa=0,qa=0,ra=0,sa=0,ta=0,ua=0,va=0,wa=0,xa=0,ya=0,za=0,Aa=0,Ba=0,Ca=0,Da=0,Ea=0,Fa=0,Ha=0,Ia=0,Ja=0,Ka=0,La=0,Ma=0,Na=0,Oa=0,Pa=0,Qa=0,Ra=0,Sa=0,Ta=0,Ua=0,Va=0,Wa=0;g=i;i=i+352|0;h=g+340|0;j=g+332|0;k=g+324|0;l=g+320|0;m=g+316|0;n=g+312|0;o=g+308|0;p=g+304|0;q=g+300|0;r=g+296|0;s=g+292|0;t=g+288|0;u=g+284|0;v=g+280|0;w=g+276|0;x=g+272|0;y=g+268|0;z=g+264|0;A=g+260|0;B=g+256|0;C=g+252|0;D=g+248|0;E=g+244|0;F=g+240|0;G=g+236|0;H=g+232|0;I=g+228|0;J=g+224|0;K=g+220|0;L=g+216|0;M=g+212|0;N=g+208|0;O=g+204|0;P=g+200|0;Q=g+196|0;R=g+192|0;S=g+188|0;T=g+184|0;U=g+180|0;V=g+176|0;W=g+172|0;X=g+168|0;Y=g+164|0;Z=g+160|0;_=g+156|0;aa=g+152|0;ba=g+148|0;ca=g+144|0;da=g+140|0;ea=g+136|0;fa=g+132|0;ga=g+128|0;ha=g+124|0;ia=g+120|0;ja=g+116|0;ka=g+112|0;la=g+108|0;ma=g+104|0;na=g+100|0;oa=g+96|0;pa=g+92|0;qa=g+88|0;ra=g+84|0;sa=g+80|0;ta=g+76|0;ua=g+72|0;va=g+68|0;wa=g+64|0;xa=g+60|0;ya=g+56|0;za=g+52|0;Aa=g+48|0;Ba=g+44|0;Ca=g+40|0;Da=g+36|0;Ea=g+32|0;Fa=g+28|0;Ha=g+24|0;Ia=g+20|0;Ja=g+16|0;Ka=g+12|0;La=g+8|0;Ma=g+4|0;Na=g;c[g+336>>2]=b;c[j>>2]=d;c[g+328>>2]=e;c[k>>2]=f;c[l>>2]=c[c[j>>2]>>2];c[m>>2]=c[(c[j>>2]|0)+4>>2];c[n>>2]=$(c[l>>2]|0,c[m>>2]|0)|0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[n>>2]|0)){break}if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[F>>2]|0)|0]|0)==103){break}c[F>>2]=(c[F>>2]|0)+1}if((c[F>>2]|0)==(c[n>>2]|0)){c[c[k>>2]>>2]=1288;c[h>>2]=0;Oa=c[h>>2]|0;i=g;return Oa|0}c[p>>2]=me((c[n>>2]|0)*9<<2)|0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=((c[n>>2]|0)*9|0)){break}c[(c[p>>2]|0)+(c[F>>2]<<2)>>2]=-1;c[F>>2]=(c[F>>2]|0)+1}c[o>>2]=me((c[n>>2]|0)*9<<2)|0;c[D>>2]=0;c[C>>2]=0;f=$(c[(c[j>>2]|0)+12>>2]|0,c[l>>2]|0)|0;c[(c[o>>2]|0)+(c[D>>2]<<2)>>2]=((f+(c[(c[j>>2]|0)+8>>2]|0)|0)*9|0)+8;c[(c[p>>2]|0)+(c[c[o>>2]>>2]<<2)>>2]=c[D>>2];c[D>>2]=(c[D>>2]|0)+1;a:while(1){Pa=c[C>>2]|0;if((c[C>>2]|0)>=(c[D>>2]|0)){break}c[C>>2]=Pa+1;c[P>>2]=c[(c[o>>2]|0)+(Pa<<2)>>2];c[K>>2]=(c[P>>2]|0)%9|0;c[L>>2]=0;while(1){if((c[L>>2]|0)>=8){continue a}c[I>>2]=(c[P>>2]|0)/9|0;c[J>>2]=(c[I>>2]|0)/(c[l>>2]|0)|0;c[I>>2]=(c[I>>2]|0)%(c[l>>2]|0)|0;if(!((c[K>>2]|0)<8?(c[K>>2]|0)!=(c[L>>2]|0):0)){Qa=16}if((((Qa|0)==16?(Qa=0,c[Q>>2]=fe(c[l>>2]|0,c[m>>2]|0,c[(c[j>>2]|0)+20>>2]|0,c[I>>2]|0,c[J>>2]|0,c[L>>2]|0)|0,(c[Q>>2]|0)>=0):0)?(c[Q>>2]|0)!=(c[P>>2]|0):0)?(c[(c[p>>2]|0)+(c[Q>>2]<<2)>>2]|0)<0:0){c[(c[o>>2]|0)+(c[D>>2]<<2)>>2]=c[Q>>2];c[(c[p>>2]|0)+(c[Q>>2]<<2)>>2]=c[D>>2];c[D>>2]=(c[D>>2]|0)+1}c[L>>2]=(c[L>>2]|0)+1}}c[H>>2]=Pa;c[q>>2]=me(c[H>>2]<<3<<2)|0;c[s>>2]=me((c[H>>2]|0)+1<<2)|0;c[v>>2]=0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[H>>2]|0)){break}c[R>>2]=c[(c[o>>2]|0)+(c[F>>2]<<2)>>2];c[(c[s>>2]|0)+(c[F>>2]<<2)>>2]=c[v>>2];c[K>>2]=(c[R>>2]|0)%9|0;c[I>>2]=(c[R>>2]|0)/9|0;c[J>>2]=(c[I>>2]|0)/(c[l>>2]|0)|0;c[I>>2]=(c[I>>2]|0)%(c[l>>2]|0)|0;c[L>>2]=0;while(1){if((c[L>>2]|0)>=8){break}if(!((c[K>>2]|0)<8?(c[K>>2]|0)!=(c[L>>2]|0):0)){Qa=27}if(((Qa|0)==27?(Qa=0,c[S>>2]=fe(c[l>>2]|0,c[m>>2]|0,c[(c[j>>2]|0)+20>>2]|0,c[I>>2]|0,c[J>>2]|0,c[L>>2]|0)|0,(c[S>>2]|0)>=0):0)?(c[S>>2]|0)!=(c[R>>2]|0):0){Pa=c[(c[p>>2]|0)+(c[S>>2]<<2)>>2]|0;Q=c[v>>2]|0;c[v>>2]=Q+1;c[(c[q>>2]|0)+(Q<<2)>>2]=Pa}c[L>>2]=(c[L>>2]|0)+1}c[F>>2]=(c[F>>2]|0)+1}c[(c[s>>2]|0)+(c[H>>2]<<2)>>2]=c[v>>2];c[r>>2]=me(c[v>>2]<<2)|0;c[t>>2]=me((c[H>>2]|0)+1<<2)|0;c[G>>2]=0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[v>>2]|0)){break}while(1){if(((c[G>>2]|0)+1|0)>=(c[H>>2]|0)){break}if((c[F>>2]|0)<(c[(c[s>>2]|0)+((c[G>>2]|0)+1<<2)>>2]|0)){break}c[G>>2]=(c[G>>2]|0)+1}L=$(c[(c[q>>2]|0)+(c[F>>2]<<2)>>2]|0,c[H>>2]|0)|0;c[(c[r>>2]|0)+(c[F>>2]<<2)>>2]=L+(c[G>>2]|0);c[F>>2]=(c[F>>2]|0)+1}Df(c[r>>2]|0,c[v>>2]|0,4,8);c[c[t>>2]>>2]=0;c[G>>2]=0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[v>>2]|0)){break}c[T>>2]=(c[(c[r>>2]|0)+(c[F>>2]<<2)>>2]|0)/(c[H>>2]|0)|0;L=(c[r>>2]|0)+(c[F>>2]<<2)|0;c[L>>2]=(c[L>>2]|0)%(c[H>>2]|0)|0;while(1){Ra=c[F>>2]|0;if((c[G>>2]|0)>=(c[T>>2]|0)){break}L=(c[G>>2]|0)+1|0;c[G>>2]=L;c[(c[t>>2]|0)+(L<<2)>>2]=Ra}c[F>>2]=Ra+1}c[(c[t>>2]|0)+(c[H>>2]<<2)>>2]=c[v>>2];c[B>>2]=256;c[u>>2]=me(c[B>>2]<<2)|0;c[A>>2]=0;v=c[A>>2]|0;c[A>>2]=v+1;c[(c[u>>2]|0)+(v<<2)>>2]=0;c[z>>2]=me(c[n>>2]<<2)|0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[n>>2]|0)){break}c[(c[z>>2]|0)+(c[F>>2]<<2)>>2]=0;c[F>>2]=(c[F>>2]|0)+1}c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[n>>2]|0)){break}if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[F>>2]|0)|0]|0)==103){c[(c[z>>2]|0)+(c[F>>2]<<2)>>2]=1}c[F>>2]=(c[F>>2]|0)+1}c[w>>2]=me(c[H>>2]<<2)|0;c[x>>2]=me(c[H>>2]<<2)|0;c[y>>2]=me(c[H>>2]<<2)|0;c[M>>2]=0;c[N>>2]=0;b:while(1){c[E>>2]=0;while(1){if((c[E>>2]|0)>=2){break}c[_>>2]=(c[E>>2]|0)==0?c[q>>2]|0:c[r>>2]|0;c[aa>>2]=(c[E>>2]|0)==0?c[s>>2]|0:c[t>>2]|0;c[ba>>2]=(c[E>>2]|0)==0?c[w>>2]|0:c[x>>2]|0;c[D>>2]=0;c[C>>2]=0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[H>>2]|0)){break}c[(c[ba>>2]|0)+(c[F>>2]<<2)>>2]=-1;c[F>>2]=(c[F>>2]|0)+1}c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[A>>2]|0)){break}c[ca>>2]=c[(c[u>>2]|0)+(c[F>>2]<<2)>>2];if((c[(c[ba>>2]|0)+(c[ca>>2]<<2)>>2]|0)<0){c[(c[ba>>2]|0)+(c[ca>>2]<<2)>>2]=0;v=c[ca>>2]|0;Ra=c[D>>2]|0;c[D>>2]=Ra+1;c[(c[y>>2]|0)+(Ra<<2)>>2]=v}c[F>>2]=(c[F>>2]|0)+1}c:while(1){if((c[C>>2]|0)>=(c[D>>2]|0)){break}v=c[C>>2]|0;c[C>>2]=v+1;c[da>>2]=c[(c[y>>2]|0)+(v<<2)>>2];c[F>>2]=c[(c[aa>>2]|0)+(c[da>>2]<<2)>>2];while(1){if((c[F>>2]|0)>=(c[(c[aa>>2]|0)+((c[da>>2]|0)+1<<2)>>2]|0)){continue c}c[ea>>2]=c[(c[_>>2]|0)+(c[F>>2]<<2)>>2];if((c[ea>>2]|0)>=0?(c[(c[ba>>2]|0)+(c[ea>>2]<<2)>>2]|0)<0:0){c[(c[ba>>2]|0)+(c[ea>>2]<<2)>>2]=(c[(c[ba>>2]|0)+(c[da>>2]<<2)>>2]|0)+1;v=c[ea>>2]|0;Ra=c[D>>2]|0;c[D>>2]=Ra+1;c[(c[y>>2]|0)+(Ra<<2)>>2]=v}c[F>>2]=(c[F>>2]|0)+1}}c[E>>2]=(c[E>>2]|0)+1}c[X>>2]=-1;c[U>>2]=-1;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[H>>2]|0)){break}do{if(((c[(c[z>>2]|0)+(((c[(c[o>>2]|0)+(c[F>>2]<<2)>>2]|0)/9|0)<<2)>>2]|0)!=0?(c[(c[w>>2]|0)+(c[F>>2]<<2)>>2]|0)>=0:0)?(c[(c[x>>2]|0)+(c[F>>2]<<2)>>2]|0)>=0:0){c[fa>>2]=(c[(c[w>>2]|0)+(c[F>>2]<<2)>>2]|0)+(c[(c[x>>2]|0)+(c[F>>2]<<2)>>2]|0);if((c[X>>2]|0)>=0?(c[X>>2]|0)<=(c[fa>>2]|0):0){break}c[X>>2]=c[fa>>2];c[U>>2]=c[F>>2]}}while(0);c[F>>2]=(c[F>>2]|0)+1}if((c[U>>2]|0)<0){break}c[E>>2]=0;while(1){if((c[E>>2]|0)>=2){break}c[ga>>2]=(c[E>>2]|0)==0?c[q>>2]|0:c[r>>2]|0;c[ha>>2]=(c[E>>2]|0)==0?c[s>>2]|0:c[t>>2]|0;c[ia>>2]=(c[E>>2]|0)==0?c[w>>2]|0:c[x>>2]|0;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[H>>2]|0)){break}c[(c[ia>>2]|0)+(c[F>>2]<<2)>>2]=-1;c[F>>2]=(c[F>>2]|0)+1}c[D>>2]=0;c[C>>2]=0;c[(c[ia>>2]|0)+(c[U>>2]<<2)>>2]=0;v=c[U>>2]|0;Ra=c[D>>2]|0;c[D>>2]=Ra+1;c[(c[y>>2]|0)+(Ra<<2)>>2]=v;d:while(1){if((c[C>>2]|0)>=(c[D>>2]|0)){break}v=c[C>>2]|0;c[C>>2]=v+1;c[ja>>2]=c[(c[y>>2]|0)+(v<<2)>>2];c[F>>2]=c[(c[ha>>2]|0)+(c[ja>>2]<<2)>>2];while(1){if((c[F>>2]|0)>=(c[(c[ha>>2]|0)+((c[ja>>2]|0)+1<<2)>>2]|0)){continue d}c[ka>>2]=c[(c[ga>>2]|0)+(c[F>>2]<<2)>>2];if((c[ka>>2]|0)>=0?(c[(c[ia>>2]|0)+(c[ka>>2]<<2)>>2]|0)<0:0){c[(c[ia>>2]|0)+(c[ka>>2]<<2)>>2]=(c[(c[ia>>2]|0)+(c[ja>>2]<<2)>>2]|0)+1;v=c[ka>>2]|0;Ra=c[D>>2]|0;c[D>>2]=Ra+1;c[(c[y>>2]|0)+(Ra<<2)>>2]=v}c[F>>2]=(c[F>>2]|0)+1}}c[E>>2]=(c[E>>2]|0)+1}c[W>>2]=-1;c[V>>2]=-1;c[X>>2]=-1;c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[A>>2]|0)){break}do{if((c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)>=0?(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)>=0:0){c[la>>2]=(c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)+(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0);if((c[X>>2]|0)>=0?(c[la>>2]|0)>=(c[X>>2]|0):0){break}c[X>>2]=c[la>>2];v=c[F>>2]|0;c[W>>2]=v;c[V>>2]=v}}while(0);do{if((((c[F>>2]|0)+1|0)<(c[A>>2]|0)?(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)>=0:0)?(c[(c[w>>2]|0)+(c[(c[u>>2]|0)+((c[F>>2]|0)+1<<2)>>2]<<2)>>2]|0)>=0:0){c[la>>2]=(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)+(c[(c[w>>2]|0)+(c[(c[u>>2]|0)+((c[F>>2]|0)+1<<2)>>2]<<2)>>2]|0);if((c[X>>2]|0)>=0?(c[la>>2]|0)>=(c[X>>2]|0):0){break}c[X>>2]=c[la>>2];c[V>>2]=c[F>>2];c[W>>2]=(c[F>>2]|0)+1}}while(0);c[F>>2]=(c[F>>2]|0)+1}if((c[X>>2]|0)<0){Qa=110;break}c[Y>>2]=(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[V>>2]<<2)>>2]<<2)>>2]|0)+(c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[W>>2]<<2)>>2]<<2)>>2]|0);if((c[V>>2]|0)!=(c[W>>2]|0)){c[Y>>2]=(c[Y>>2]|0)+ -1}c[A>>2]=(c[A>>2]|0)+(c[Y>>2]|0);if((c[A>>2]|0)>=(c[B>>2]|0)){c[B>>2]=(c[A>>2]|0)+256;c[u>>2]=oe(c[u>>2]|0,c[B>>2]<<2)|0}cg((c[u>>2]|0)+(c[W>>2]<<2)+(c[Y>>2]<<2)|0,(c[u>>2]|0)+(c[W>>2]<<2)|0,(c[A>>2]|0)-(c[W>>2]|0)-(c[Y>>2]|0)<<2|0)|0;c[W>>2]=(c[W>>2]|0)+(c[Y>>2]|0);c[Z>>2]=(c[V>>2]|0)+(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[V>>2]<<2)>>2]<<2)>>2]|0);if(((c[Z>>2]|0)-(c[(c[x>>2]|0)+(c[(c[u>>2]|0)+(c[V>>2]<<2)>>2]<<2)>>2]|0)|0)!=(c[V>>2]|0)){Qa=116;break}if(((c[Z>>2]|0)+(c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[W>>2]<<2)>>2]<<2)>>2]|0)|0)!=(c[W>>2]|0)){Qa=118;break}c[E>>2]=0;while(1){if((c[E>>2]|0)>=2){break}c[ma>>2]=(c[E>>2]|0)==0?-1:1;c[na>>2]=(c[E>>2]|0)==0?c[r>>2]|0:c[q>>2]|0;c[oa>>2]=(c[E>>2]|0)==0?c[t>>2]|0:c[s>>2]|0;c[pa>>2]=(c[E>>2]|0)==0?c[w>>2]|0:c[x>>2]|0;c[qa>>2]=(c[E>>2]|0)==0?c[W>>2]|0:c[V>>2]|0;c[ra>>2]=c[(c[u>>2]|0)+(c[qa>>2]<<2)>>2];c[ta>>2]=c[qa>>2];while(1){c[(c[u>>2]|0)+(c[ta>>2]<<2)>>2]=c[ra>>2];if((c[(c[pa>>2]|0)+(c[ra>>2]<<2)>>2]|0)==0){break}c[ta>>2]=(c[ta>>2]|0)+(c[ma>>2]|0);c[sa>>2]=-1;c[F>>2]=c[(c[oa>>2]|0)+(c[ra>>2]<<2)>>2];while(1){if((c[F>>2]|0)>=(c[(c[oa>>2]|0)+((c[ra>>2]|0)+1<<2)>>2]|0)){break}c[sa>>2]=c[(c[na>>2]|0)+(c[F>>2]<<2)>>2];if((c[sa>>2]|0)>=0?(c[(c[pa>>2]|0)+(c[sa>>2]<<2)>>2]|0)==((c[(c[pa>>2]|0)+(c[ra>>2]<<2)>>2]|0)-1|0):0){break}c[F>>2]=(c[F>>2]|0)+1}if((c[F>>2]|0)>=(c[(c[oa>>2]|0)+((c[ra>>2]|0)+1<<2)>>2]|0)){Qa=130;break b}if((c[sa>>2]|0)<0){Qa=130;break b}c[ra>>2]=c[sa>>2]}c[E>>2]=(c[E>>2]|0)+1}c[F>>2]=c[V>>2];while(1){if((c[F>>2]|0)>(c[W>>2]|0)){continue b}c[ua>>2]=(c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)/9|0;if((c[ua>>2]|0)<0){Qa=137;break b}if((c[ua>>2]|0)>=(c[n>>2]|0)){Qa=137;break b}c[(c[z>>2]|0)+(c[ua>>2]<<2)>>2]=0;c[F>>2]=(c[F>>2]|0)+1}}if((Qa|0)==110){c[M>>2]=1312}else if((Qa|0)==116){Ga(1368,840,1135,1408)}else if((Qa|0)==118){Ga(1424,840,1136,1408)}else if((Qa|0)==130){Ga(1464,840,1157,1408)}else if((Qa|0)==137){Ga(1488,840,1176,1408)}e:while(1){c[va>>2]=c[A>>2];c[wa>>2]=1;while(1){if(!((c[wa>>2]|0)>=-1)){break}c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[n>>2]|0)){break}c[(c[z>>2]|0)+(c[F>>2]<<2)>>2]=0;c[F>>2]=(c[F>>2]|0)+1}c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[A>>2]|0)){break}c[xa>>2]=(c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)/9|0;if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[xa>>2]|0)|0]|0)==103){ua=(c[z>>2]|0)+(c[xa>>2]<<2)|0;c[ua>>2]=(c[ua>>2]|0)+1}c[F>>2]=(c[F>>2]|0)+1}c[F>>2]=0;while(1){if((c[F>>2]|0)>=(c[n>>2]|0)){break}if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[F>>2]|0)|0]|0)==103?(c[(c[z>>2]|0)+(c[F>>2]<<2)>>2]|0)==0:0){Qa=153;break}c[F>>2]=(c[F>>2]|0)+1}if((Qa|0)==153){Qa=0;c[M>>2]=1312}if((c[F>>2]|0)<(c[n>>2]|0)){break}if((c[wa>>2]|0)>0){Sa=0}else{Sa=(c[A>>2]|0)-1|0}c[G>>2]=Sa;c[F>>2]=Sa;while(1){if(!((c[F>>2]|0)<(c[A>>2]|0)&(c[F>>2]|0)>=0)){break}c[ya>>2]=(c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)/9|0;if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[ya>>2]|0)|0]|0)==103?(c[(c[z>>2]|0)+(c[ya>>2]<<2)>>2]|0)>1:0){ua=(c[z>>2]|0)+(c[ya>>2]<<2)|0;c[ua>>2]=(c[ua>>2]|0)+ -1}else{Qa=163}do{if((Qa|0)==163){Qa=0;if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[ya>>2]|0)|0]|0)!=103?(c[F>>2]|0)!=((c[A>>2]|0)-1|0):0){break}c[za>>2]=(c[F>>2]|0)<(c[G>>2]|0)?c[F>>2]|0:c[G>>2]|0;c[Aa>>2]=(c[F>>2]|0)>(c[G>>2]|0)?c[F>>2]|0:c[G>>2]|0;c[Ba>>2]=0;while(1){if((c[Ba>>2]|0)>=(c[H>>2]|0)){break}c[(c[w>>2]|0)+(c[Ba>>2]<<2)>>2]=-1;c[Ba>>2]=(c[Ba>>2]|0)+1}c[D>>2]=0;c[C>>2]=0;c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[za>>2]<<2)>>2]<<2)>>2]=0;ua=c[(c[u>>2]|0)+(c[za>>2]<<2)>>2]|0;W=c[D>>2]|0;c[D>>2]=W+1;c[(c[y>>2]|0)+(W<<2)>>2]=ua;f:while(1){if((c[C>>2]|0)>=(c[D>>2]|0)){break}if((c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[Aa>>2]<<2)>>2]<<2)>>2]|0)>=0){break}ua=c[C>>2]|0;c[C>>2]=ua+1;c[Ha>>2]=c[(c[y>>2]|0)+(ua<<2)>>2];c[Ba>>2]=c[(c[s>>2]|0)+(c[Ha>>2]<<2)>>2];while(1){if((c[Ba>>2]|0)>=(c[(c[s>>2]|0)+((c[Ha>>2]|0)+1<<2)>>2]|0)){continue f}c[Ia>>2]=c[(c[q>>2]|0)+(c[Ba>>2]<<2)>>2];if((c[Ia>>2]|0)>=0?(c[(c[w>>2]|0)+(c[Ia>>2]<<2)>>2]|0)<0:0){c[(c[w>>2]|0)+(c[Ia>>2]<<2)>>2]=(c[(c[w>>2]|0)+(c[Ha>>2]<<2)>>2]|0)+1;ua=c[Ia>>2]|0;W=c[D>>2]|0;c[D>>2]=W+1;c[(c[y>>2]|0)+(W<<2)>>2]=ua}c[Ba>>2]=(c[Ba>>2]|0)+1}}c[Fa>>2]=c[(c[w>>2]|0)+(c[(c[u>>2]|0)+(c[Aa>>2]<<2)>>2]<<2)>>2];if((c[Fa>>2]|0)<0){Qa=179;break e}if((c[Fa>>2]|0)>((c[Aa>>2]|0)-(c[za>>2]|0)|0)){Qa=179;break e}cg((c[u>>2]|0)+(c[za>>2]<<2)+(c[Fa>>2]<<2)|0,(c[u>>2]|0)+(c[Aa>>2]<<2)|0,(c[A>>2]|0)-(c[Aa>>2]|0)<<2|0)|0;c[A>>2]=(c[A>>2]|0)-((c[Aa>>2]|0)-(c[za>>2]|0));c[Aa>>2]=(c[za>>2]|0)+(c[Fa>>2]|0);c[A>>2]=(c[A>>2]|0)+((c[Aa>>2]|0)-(c[za>>2]|0));if((c[wa>>2]|0)>0){c[F>>2]=c[Aa>>2]}c[Ca>>2]=c[Aa>>2];if((c[Ca>>2]|0)<0){Qa=183;break e}c[Da>>2]=c[(c[u>>2]|0)+(c[Aa>>2]<<2)>>2];while(1){c[(c[u>>2]|0)+(c[Ca>>2]<<2)>>2]=c[Da>>2];if((c[(c[w>>2]|0)+(c[Da>>2]<<2)>>2]|0)==0){break}c[Ca>>2]=(c[Ca>>2]|0)+ -1;c[Ea>>2]=-1;c[Ba>>2]=c[(c[t>>2]|0)+(c[Da>>2]<<2)>>2];while(1){if((c[Ba>>2]|0)>=(c[(c[t>>2]|0)+((c[Da>>2]|0)+1<<2)>>2]|0)){break}c[Ea>>2]=c[(c[r>>2]|0)+(c[Ba>>2]<<2)>>2];if((c[Ea>>2]|0)>=0?(c[(c[w>>2]|0)+(c[Ea>>2]<<2)>>2]|0)==((c[(c[w>>2]|0)+(c[Da>>2]<<2)>>2]|0)-1|0):0){break}c[Ba>>2]=(c[Ba>>2]|0)+1}if((c[Ba>>2]|0)>=(c[(c[t>>2]|0)+((c[Da>>2]|0)+1<<2)>>2]|0)){Qa=193;break e}if((c[Ea>>2]|0)<0){Qa=193;break e}c[Da>>2]=c[Ea>>2]}while(1){ua=(c[za>>2]|0)+1|0;c[za>>2]=ua;if((ua|0)>=(c[Aa>>2]|0)){break}c[Ja>>2]=(c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[za>>2]<<2)>>2]<<2)>>2]|0)/9|0;if((a[(c[(c[j>>2]|0)+20>>2]|0)+(c[Ja>>2]|0)|0]|0)!=103){continue}ua=(c[z>>2]|0)+(c[Ja>>2]<<2)|0;c[ua>>2]=(c[ua>>2]|0)+1}c[G>>2]=c[F>>2]}}while(0);c[F>>2]=(c[F>>2]|0)+(c[wa>>2]|0)}c[wa>>2]=(c[wa>>2]|0)-2}if((c[A>>2]|0)==(c[va>>2]|0)){Qa=202;break}}if((Qa|0)==179){Ga(1512,840,1290,1408)}else if((Qa|0)==183){Ga(1552,840,1306,1408)}else if((Qa|0)==193){Ga(1568,840,1321,1408)}else if((Qa|0)==202){do{if((c[M>>2]|0)==0){c[N>>2]=me((c[A>>2]|0)+2|0)|0;c[O>>2]=c[N>>2];va=c[O>>2]|0;c[O>>2]=va+1;a[va]=83;c[I>>2]=((c[(c[o>>2]|0)+(c[c[u>>2]>>2]<<2)>>2]|0)/9|0|0)%(c[l>>2]|0)|0;c[J>>2]=((c[(c[o>>2]|0)+(c[c[u>>2]>>2]<<2)>>2]|0)/9|0|0)/(c[l>>2]|0)|0;c[F>>2]=1;while(1){if((c[F>>2]|0)>=(c[A>>2]|0)){break}if(((c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)%9|0|0)==8){c[Ka>>2]=((c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)/9|0|0)%(c[l>>2]|0)|0;c[La>>2]=((c[(c[o>>2]|0)+(c[(c[u>>2]|0)+(c[F>>2]<<2)>>2]<<2)>>2]|0)/9|0|0)/(c[l>>2]|0)|0;if((c[Ka>>2]|0)>(c[I>>2]|0)){Ta=1}else{Ta=(c[Ka>>2]|0)<(c[I>>2]|0)?-1:0}c[Ma>>2]=Ta;if((c[La>>2]|0)>(c[J>>2]|0)){Ua=1}else{Ua=(c[La>>2]|0)<(c[J>>2]|0)?-1:0}c[Na>>2]=Ua;c[K>>2]=0;while(1){if((c[K>>2]|0)>=8){break}if((c[K>>2]&3|0)!=0){Va=(c[K>>2]&7|0)>4?-1:1}else{Va=0}if((Va|0)==(c[Ma>>2]|0)){if(((c[K>>2]|0)+6&3|0)!=0){Wa=((c[K>>2]|0)+6&7|0)>4?-1:1}else{Wa=0}if((Wa|0)==(c[Na>>2]|0)){Qa=218;break}}c[K>>2]=(c[K>>2]|0)+1}if((Qa|0)==218){Qa=0;va=48+(c[K>>2]|0)&255;wa=c[O>>2]|0;c[O>>2]=wa+1;a[wa]=va}if((c[K>>2]|0)>=8){Qa=221;break}c[I>>2]=c[Ka>>2];c[J>>2]=c[La>>2]}c[F>>2]=(c[F>>2]|0)+1}if((Qa|0)==221){Ga(1600,840,1419,1408)}va=c[O>>2]|0;c[O>>2]=va+1;a[va]=0;if(((c[O>>2]|0)-(c[N>>2]|0)|0)<((c[A>>2]|0)+2|0)){break}else{Ga(1616,840,1424,1408)}}}while(0);ne(c[y>>2]|0);ne(c[w>>2]|0);ne(c[x>>2]|0);ne(c[z>>2]|0);ne(c[u>>2]|0);ne(c[t>>2]|0);ne(c[r>>2]|0);ne(c[s>>2]|0);ne(c[q>>2]|0);ne(c[p>>2]|0);ne(c[o>>2]|0);if((c[M>>2]|0)!=0){c[c[k>>2]>>2]=c[M>>2]}c[h>>2]=c[N>>2];Oa=c[h>>2]|0;i=g;return Oa|0}return 0}function Id(a){a=a|0;var b=0;b=i;i=i+16|0;c[b>>2]=a;i=b;return 1}function Jd(b){b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0;d=i;i=i+64|0;e=d;f=d+60|0;g=d+56|0;h=d+52|0;j=d+48|0;k=d+44|0;l=d+40|0;m=d+36|0;n=d+32|0;o=d+28|0;p=d+24|0;q=d+20|0;r=d+16|0;s=d+12|0;t=d+8|0;c[f>>2]=b;c[g>>2]=c[c[f>>2]>>2];c[h>>2]=c[(c[f>>2]|0)+4>>2];c[l>>2]=4;c[m>>2]=2;c[n>>2]=($(c[l>>2]|0,c[g>>2]|0)|0)+2;c[o>>2]=($(c[m>>2]|0,c[h>>2]|0)|0)+1;c[p>>2]=$(c[n>>2]|0,c[o>>2]|0)|0;c[q>>2]=me((c[p>>2]|0)+1|0)|0;o=c[q>>2]|0;c[e>>2]=(c[p>>2]|0)-2;c[e+4>>2]=1264;fb(o|0,1256,e|0)|0;c[j>>2]=0;while(1){if((c[j>>2]|0)>=(c[h>>2]|0)){break}c[k>>2]=0;while(1){if((c[k>>2]|0)>=(c[g>>2]|0)){break}e=$(c[j>>2]|0,c[m>>2]|0)|0;o=$(e,c[n>>2]|0)|0;c[r>>2]=o+($(c[l>>2]|0,c[k>>2]|0)|0);o=(c[r>>2]|0)+(($(c[n>>2]|0,c[m>>2]|0)|0)/2|0)|0;c[s>>2]=o+((c[l>>2]|0)/2|0);o=$(c[j>>2]|0,c[g>>2]|0)|0;c[t>>2]=o+(c[k>>2]|0);o=a[(c[(c[f>>2]|0)+20>>2]|0)+(c[t>>2]|0)|0]|0;if((o|0)==103){a[(c[q>>2]|0)+(c[s>>2]|0)|0]=111}else if((o|0)==109){a[(c[q>>2]|0)+(c[s>>2]|0)|0]=77}else if((o|0)==115){a[(c[q>>2]|0)+((c[s>>2]|0)-1)|0]=40;a[(c[q>>2]|0)+((c[s>>2]|0)+1)|0]=41}else if((o|0)==119){o=(c[q>>2]|0)+(c[s>>2]|0)+ -1|0;a[o+0|0]=88;a[o+1|0]=88;a[o+2|0]=88}do{if((c[j>>2]|0)==(c[(c[f>>2]|0)+12>>2]|0)?(c[k>>2]|0)==(c[(c[f>>2]|0)+8>>2]|0):0){if(a[(c[f>>2]|0)+28|0]&1){o=(c[q>>2]|0)+(c[s>>2]|0)+ -1|0;a[o+0|0]=a[1272|0]|0;a[o+1|0]=a[1273|0]|0;a[o+2|0]=a[1274|0]|0;break}else{a[(c[q>>2]|0)+(c[s>>2]|0)|0]=64;break}}}while(0);a[(c[q>>2]|0)+(c[r>>2]|0)|0]=43;eg((c[q>>2]|0)+(c[r>>2]|0)+1|0,45,(c[l>>2]|0)-1|0)|0;c[t>>2]=1;while(1){if((c[t>>2]|0)>=(c[m>>2]|0)){break}o=(c[r>>2]|0)+($(c[t>>2]|0,c[n>>2]|0)|0)|0;a[(c[q>>2]|0)+o|0]=124;c[t>>2]=(c[t>>2]|0)+1}c[k>>2]=(c[k>>2]|0)+1}c[k>>2]=0;while(1){if((c[k>>2]|0)>=(c[m>>2]|0)){break}o=$(c[j>>2]|0,c[m>>2]|0)|0;e=$(o+(c[k>>2]|0)|0,c[n>>2]|0)|0;a[(c[q>>2]|0)+(e+(c[n>>2]|0)-2)|0]=a[1280+(((c[k>>2]|0)!=0^1)&1)|0]|0;e=$(c[j>>2]|0,c[m>>2]|0)|0;o=$(e+(c[k>>2]|0)|0,c[n>>2]|0)|0;a[(c[q>>2]|0)+(o+(c[n>>2]|0)-1)|0]=10;c[k>>2]=(c[k>>2]|0)+1}c[j>>2]=(c[j>>2]|0)+1}eg((c[q>>2]|0)+(c[p>>2]|0)+(0-(c[n>>2]|0))|0,45,(c[n>>2]|0)-2|0)|0;c[k>>2]=0;while(1){if((c[k>>2]|0)>=(c[g>>2]|0)){break}j=(c[p>>2]|0)-(c[n>>2]|0)+($(c[l>>2]|0,c[k>>2]|0)|0)|0;a[(c[q>>2]|0)+j|0]=43;c[k>>2]=(c[k>>2]|0)+1}i=d;return c[q>>2]|0}function Kd(b){b=b|0;var d=0,e=0;d=i;i=i+16|0;e=d;c[d+4>>2]=b;c[e>>2]=me(16)|0;g[c[e>>2]>>2]=0.0;c[(c[e>>2]|0)+4>>2]=0;c[(c[e>>2]|0)+8>>2]=0;a[(c[e>>2]|0)+12|0]=0;a[(c[e>>2]|0)+13|0]=0;i=d;return c[e>>2]|0}function Ld(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;ne(c[d>>2]|0);i=b;return}function Md(a){a=a|0;var b=0,d=0,e=0,f=0;b=i;i=i+96|0;d=b;e=b+4|0;f=b+8|0;c[e>>2]=a;c[d>>2]=c[(c[e>>2]|0)+8>>2];fb(f|0,1248,d|0)|0;d=pe(f)|0;i=b;return d|0}function Nd(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0;d=i;i=i+32|0;e=d;f=d+16|0;g=d+12|0;h=d+8|0;c[f>>2]=a;c[g>>2]=b;c[h>>2]=0;b=c[g>>2]|0;c[e>>2]=(c[f>>2]|0)+8;c[e+4>>2]=h;Na(b|0,1240,e|0)|0;i=d;return}function Od(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0;f=i;i=i+16|0;g=f+8|0;h=f+4|0;j=f;c[g>>2]=b;c[h>>2]=d;c[j>>2]=e;if(((!(a[(c[h>>2]|0)+28|0]&1)?a[(c[j>>2]|0)+28|0]&1:0)?a[(c[g>>2]|0)+12|0]&1:0)?(c[(c[h>>2]|0)+16>>2]|0)!=0:0){h=(c[g>>2]|0)+8|0;c[h>>2]=(c[h>>2]|0)+1;a[(c[g>>2]|0)+13|0]=1;k=c[g>>2]|0;l=k+12|0;a[l]=0;i=f;return}a[(c[g>>2]|0)+13|0]=0;k=c[g>>2]|0;l=k+12|0;a[l]=0;i=f;return}function Pd(b,e,f,h,j,k){b=b|0;e=e|0;f=f|0;h=h|0;j=j|0;k=k|0;var l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0;l=i;i=i+144|0;m=l;n=l+52|0;o=l+48|0;p=l+44|0;q=l+40|0;r=l+36|0;s=l+32|0;t=l+28|0;u=l+24|0;v=l+20|0;w=l+16|0;x=l+56|0;y=l+12|0;z=l+8|0;A=l+4|0;c[o>>2]=b;c[p>>2]=e;c[q>>2]=f;c[r>>2]=h;c[s>>2]=j;c[t>>2]=k;c[u>>2]=c[c[o>>2]>>2];c[v>>2]=c[(c[o>>2]|0)+4>>2];c[w>>2]=-1;do{if((c[t>>2]|0)==512){if(((((c[r>>2]|0)-(c[(c[q>>2]|0)+8>>2]|0)+(c[(c[q>>2]|0)+8>>2]|0)|0)/(c[(c[q>>2]|0)+8>>2]|0)|0)-1|0)==(c[(c[o>>2]|0)+8>>2]|0)?((((c[s>>2]|0)-(c[(c[q>>2]|0)+8>>2]|0)+(c[(c[q>>2]|0)+8>>2]|0)|0)/(c[(c[q>>2]|0)+8>>2]|0)|0)-1|0)==(c[(c[o>>2]|0)+12>>2]|0):0){break}c[y>>2]=(((c[r>>2]|0)-(c[(c[q>>2]|0)+8>>2]|0)+(c[(c[q>>2]|0)+8>>2]|0)|0)/(c[(c[q>>2]|0)+8>>2]|0)|0)-1-(c[(c[o>>2]|0)+8>>2]|0);c[z>>2]=(((c[s>>2]|0)-(c[(c[q>>2]|0)+8>>2]|0)+(c[(c[q>>2]|0)+8>>2]|0)|0)/(c[(c[q>>2]|0)+8>>2]|0)|0)-1-(c[(c[o>>2]|0)+12>>2]|0);g[A>>2]=+X(+(+(c[y>>2]|0)),+(+(0-(c[z>>2]|0)|0)));g[A>>2]=(+g[A>>2]+.39269908169872414)/.7853981633974483;if(+g[A>>2]>-16.0){c[w>>2]=~~(+g[A>>2]+16.0)&7;break}else{Ga(1200,840,1597,1216)}}else{if((c[t>>2]|0)==521|(c[t>>2]|0)==16440){c[w>>2]=0;break}if((c[t>>2]|0)==522|(c[t>>2]|0)==16434){c[w>>2]=4;break}if((c[t>>2]|0)==523|(c[t>>2]|0)==16436){c[w>>2]=6;break}if((c[t>>2]|0)==524|(c[t>>2]|0)==16438){c[w>>2]=2;break}if((c[t>>2]|0)==16439){c[w>>2]=7;break}if((c[t>>2]|0)==16433){c[w>>2]=5;break}if((c[t>>2]|0)==16441){c[w>>2]=1;break}if((c[t>>2]|0)==16435){c[w>>2]=3;break}if(((c[t>>2]|0)==525|(c[t>>2]|0)==526?(c[(c[o>>2]|0)+36>>2]|0)!=0:0)?(c[(c[o>>2]|0)+32>>2]|0)<(c[(c[(c[o>>2]|0)+36>>2]|0)+4>>2]|0):0){c[w>>2]=d[(c[(c[(c[o>>2]|0)+36>>2]|0)+8>>2]|0)+(c[(c[o>>2]|0)+32>>2]|0)|0]|0}}}while(0);if((c[w>>2]|0)<0){c[n>>2]=0;B=c[n>>2]|0;i=l;return B|0}if((c[w>>2]&3|0)!=0){C=(c[w>>2]&7|0)>4?-1:1}else{C=0}if(((c[(c[o>>2]|0)+8>>2]|0)+C|0)>=0){if((c[w>>2]&3|0)!=0){D=(c[w>>2]&7|0)>4?-1:1}else{D=0}if(((c[(c[o>>2]|0)+8>>2]|0)+D|0)<(c[u>>2]|0)){if(((c[w>>2]|0)+6&3|0)!=0){E=((c[w>>2]|0)+6&7|0)>4?-1:1}else{E=0}if(((c[(c[o>>2]|0)+12>>2]|0)+E|0)>=0){if(((c[w>>2]|0)+6&3|0)!=0){F=((c[w>>2]|0)+6&7|0)>4?-1:1}else{F=0}if(((c[(c[o>>2]|0)+12>>2]|0)+F|0)<(c[v>>2]|0)){if(((c[w>>2]|0)+6&3|0)!=0){G=((c[w>>2]|0)+6&7|0)>4?-1:1}else{G=0}v=$((c[(c[o>>2]|0)+12>>2]|0)+G|0,c[u>>2]|0)|0;if((c[w>>2]&3|0)!=0){H=(c[w>>2]&7|0)>4?-1:1}else{H=0}I=a[(c[(c[o>>2]|0)+20>>2]|0)+(v+((c[(c[o>>2]|0)+8>>2]|0)+H))|0]|0}else{I=119}}else{I=119}}else{I=119}}else{I=119}if((I|0)==119){c[n>>2]=0;B=c[n>>2]|0;i=l;return B|0}if(a[(c[o>>2]|0)+28|0]&1){c[n>>2]=0;B=c[n>>2]|0;i=l;return B|0}else{a[(c[p>>2]|0)+12|0]=1;c[m>>2]=c[w>>2];fb(x|0,1232,m|0)|0;c[n>>2]=pe(x)|0;B=c[n>>2]|0;i=l;return B|0}return 0}function Qd(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0;f=i;i=i+48|0;g=f+32|0;h=f+28|0;j=f+24|0;k=f+20|0;l=f+16|0;m=f+12|0;n=f+8|0;o=f+4|0;p=f;c[h>>2]=b;c[j>>2]=e;c[k>>2]=c[c[h>>2]>>2];c[l>>2]=c[(c[h>>2]|0)+4>>2];if((a[c[j>>2]|0]|0)==83){c[n>>2]=Fd(c[h>>2]|0)|0;de(c[n>>2]|0,c[j>>2]|0);c[g>>2]=c[n>>2];q=c[g>>2]|0;i=f;return q|0}c[m>>2]=Wf(c[j>>2]|0)|0;if((c[m>>2]|0)<0|(c[m>>2]|0)>=8){c[g>>2]=0;q=c[g>>2]|0;i=f;return q|0}if(a[(c[h>>2]|0)+28|0]&1){c[g>>2]=0;q=c[g>>2]|0;i=f;return q|0}if((c[m>>2]&3|0)!=0){r=(c[m>>2]&7|0)>4?-1:1}else{r=0}if(((c[(c[h>>2]|0)+8>>2]|0)+r|0)>=0){if((c[m>>2]&3|0)!=0){s=(c[m>>2]&7|0)>4?-1:1}else{s=0}if(((c[(c[h>>2]|0)+8>>2]|0)+s|0)<(c[k>>2]|0)){if(((c[m>>2]|0)+6&3|0)!=0){t=((c[m>>2]|0)+6&7|0)>4?-1:1}else{t=0}if(((c[(c[h>>2]|0)+12>>2]|0)+t|0)>=0){if(((c[m>>2]|0)+6&3|0)!=0){u=((c[m>>2]|0)+6&7|0)>4?-1:1}else{u=0}if(((c[(c[h>>2]|0)+12>>2]|0)+u|0)<(c[l>>2]|0)){if(((c[m>>2]|0)+6&3|0)!=0){v=((c[m>>2]|0)+6&7|0)>4?-1:1}else{v=0}u=$((c[(c[h>>2]|0)+12>>2]|0)+v|0,c[k>>2]|0)|0;if((c[m>>2]&3|0)!=0){w=(c[m>>2]&7|0)>4?-1:1}else{w=0}x=a[(c[(c[h>>2]|0)+20>>2]|0)+(u+((c[(c[h>>2]|0)+8>>2]|0)+w))|0]|0}else{x=119}}else{x=119}}else{x=119}}else{x=119}if((x|0)==119){c[g>>2]=0;q=c[g>>2]|0;i=f;return q|0}c[n>>2]=Fd(c[h>>2]|0)|0;c[(c[n>>2]|0)+24>>2]=0;do{if((c[m>>2]&3|0)!=0){y=(c[m>>2]&7|0)>4?-1:1}else{y=0}h=(c[n>>2]|0)+8|0;c[h>>2]=(c[h>>2]|0)+y;if(((c[m>>2]|0)+6&3|0)!=0){z=((c[m>>2]|0)+6&7|0)>4?-1:1}else{z=0}h=(c[n>>2]|0)+12|0;c[h>>2]=(c[h>>2]|0)+z;h=(c[n>>2]|0)+24|0;c[h>>2]=(c[h>>2]|0)+1;if((((c[(c[n>>2]|0)+8>>2]|0)>=0?(c[(c[n>>2]|0)+8>>2]|0)<(c[k>>2]|0):0)?(c[(c[n>>2]|0)+12>>2]|0)>=0:0)?(c[(c[n>>2]|0)+12>>2]|0)<(c[l>>2]|0):0){h=$(c[(c[n>>2]|0)+12>>2]|0,c[k>>2]|0)|0;A=a[(c[(c[n>>2]|0)+20>>2]|0)+(h+(c[(c[n>>2]|0)+8>>2]|0))|0]|0}else{A=119}if((A|0)==103){h=$(c[(c[n>>2]|0)+12>>2]|0,c[k>>2]|0)|0;a[(c[(c[n>>2]|0)+20>>2]|0)+(h+(c[(c[n>>2]|0)+8>>2]|0))|0]=98;h=(c[n>>2]|0)+16|0;c[h>>2]=(c[h>>2]|0)+ -1}if((((c[(c[n>>2]|0)+8>>2]|0)>=0?(c[(c[n>>2]|0)+8>>2]|0)<(c[k>>2]|0):0)?(c[(c[n>>2]|0)+12>>2]|0)>=0:0)?(c[(c[n>>2]|0)+12>>2]|0)<(c[l>>2]|0):0){h=$(c[(c[n>>2]|0)+12>>2]|0,c[k>>2]|0)|0;B=a[(c[(c[n>>2]|0)+20>>2]|0)+(h+(c[(c[n>>2]|0)+8>>2]|0))|0]|0}else{B=119}C=c[n>>2]|0;if((B|0)==109){D=44;break}if((((c[C+8>>2]|0)>=0?(c[(c[n>>2]|0)+8>>2]|0)<(c[k>>2]|0):0)?(c[(c[n>>2]|0)+12>>2]|0)>=0:0)?(c[(c[n>>2]|0)+12>>2]|0)<(c[l>>2]|0):0){h=$(c[(c[n>>2]|0)+12>>2]|0,c[k>>2]|0)|0;E=a[(c[(c[n>>2]|0)+20>>2]|0)+(h+(c[(c[n>>2]|0)+8>>2]|0))|0]|0}else{E=119}if((E|0)==115){break}if((c[m>>2]&3|0)!=0){F=(c[m>>2]&7|0)>4?-1:1}else{F=0}if(((c[(c[n>>2]|0)+8>>2]|0)+F|0)>=0){if((c[m>>2]&3|0)!=0){G=(c[m>>2]&7|0)>4?-1:1}else{G=0}if(((c[(c[n>>2]|0)+8>>2]|0)+G|0)<(c[k>>2]|0)){if(((c[m>>2]|0)+6&3|0)!=0){H=((c[m>>2]|0)+6&7|0)>4?-1:1}else{H=0}if(((c[(c[n>>2]|0)+12>>2]|0)+H|0)>=0){if(((c[m>>2]|0)+6&3|0)!=0){I=((c[m>>2]|0)+6&7|0)>4?-1:1}else{I=0}if(((c[(c[n>>2]|0)+12>>2]|0)+I|0)<(c[l>>2]|0)){if(((c[m>>2]|0)+6&3|0)!=0){J=((c[m>>2]|0)+6&7|0)>4?-1:1}else{J=0}h=$((c[(c[n>>2]|0)+12>>2]|0)+J|0,c[k>>2]|0)|0;if((c[m>>2]&3|0)!=0){K=(c[m>>2]&7|0)>4?-1:1}else{K=0}L=a[(c[(c[n>>2]|0)+20>>2]|0)+(h+((c[(c[n>>2]|0)+8>>2]|0)+K))|0]|0}else{L=119}}else{L=119}}else{L=119}}else{L=119}}while((L|0)!=119);if((D|0)==44){a[C+28|0]=1}do{if((c[(c[n>>2]|0)+36>>2]|0)!=0){if(!(a[(c[n>>2]|0)+28|0]&1)?(c[(c[n>>2]|0)+16>>2]|0)!=0:0){if((d[(c[(c[(c[n>>2]|0)+36>>2]|0)+8>>2]|0)+(c[(c[n>>2]|0)+32>>2]|0)|0]|0)!=(c[m>>2]|0)){c[o>>2]=0;c[p>>2]=Hd(0,c[n>>2]|0,0,o)|0;C=c[n>>2]|0;if((c[o>>2]|0)!=0){ee(C);break}else{de(C,c[p>>2]|0);ne(c[p>>2]|0);break}}C=(c[n>>2]|0)+32|0;c[C>>2]=(c[C>>2]|0)+1;if((c[(c[n>>2]|0)+32>>2]|0)>=(c[(c[(c[n>>2]|0)+36>>2]|0)+4>>2]|0)){Ga(1048,840,1734,1080)}if(a[(c[n>>2]|0)+28|0]&1){Ga(1096,840,1735,1080)}else{break}}ee(c[n>>2]|0)}}while(0);c[g>>2]=c[n>>2];q=c[g>>2]|0;i=f;return q|0}function Rd(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0;f=i;i=i+32|0;g=f+20|0;h=f+16|0;j=f+12|0;k=f+8|0;l=f+4|0;m=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[m>>2]=l;c[l>>2]=c[h>>2];h=(c[c[m>>2]>>2]<<1)+1+($(c[c[g>>2]>>2]|0,c[c[m>>2]>>2]|0)|0)|0;c[c[j>>2]>>2]=h;h=(c[c[m>>2]>>2]<<1)+1+($(c[(c[g>>2]|0)+4>>2]|0,c[c[m>>2]>>2]|0)|0)|0;c[c[k>>2]>>2]=h;i=f;return}function Sd(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0;g=i;i=i+16|0;h=g+12|0;j=g+8|0;k=g;c[h>>2]=b;c[j>>2]=d;c[g+4>>2]=e;c[k>>2]=f;c[(c[j>>2]|0)+8>>2]=c[k>>2];if((c[(c[j>>2]|0)+20>>2]|0)!=0){Ga(1008,840,1769,1032)}if(a[(c[j>>2]|0)+24|0]&1){Ga(984,840,1770,1032)}else{k=vc(c[h>>2]|0,c[(c[j>>2]|0)+8>>2]|0,c[(c[j>>2]|0)+8>>2]|0)|0;c[(c[j>>2]|0)+20>>2]=k;i=g;return}}function Td(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,h=0,j=0;d=i;i=i+16|0;e=d+12|0;f=d+8|0;h=d+4|0;j=d;c[e>>2]=a;c[f>>2]=b;c[h>>2]=me(120)|0;pf(c[e>>2]|0,c[h>>2]|0,0,2,3);g[(c[h>>2]|0)+12>>2]=0.0;g[(c[h>>2]|0)+16>>2]=0.0;g[(c[h>>2]|0)+20>>2]=0.0;g[(c[h>>2]|0)+48>>2]=0.0;g[(c[h>>2]|0)+52>>2]=1.0;g[(c[h>>2]|0)+56>>2]=0.0;g[(c[h>>2]|0)+60>>2]=1.0;g[(c[h>>2]|0)+64>>2]=0.0;g[(c[h>>2]|0)+68>>2]=0.0;g[(c[h>>2]|0)+72>>2]=0.0;g[(c[h>>2]|0)+76>>2]=0.0;g[(c[h>>2]|0)+80>>2]=0.0;g[(c[h>>2]|0)+84>>2]=.6000000238418579;g[(c[h>>2]|0)+88>>2]=1.0;g[(c[h>>2]|0)+92>>2]=1.0;c[j>>2]=0;while(1){if((c[j>>2]|0)>=3){break}g[(c[h>>2]|0)+(24+(c[j>>2]|0)<<2)>>2]=(+g[(c[h>>2]|0)+(0+(c[j>>2]|0)<<2)>>2]*3.0+ +g[(c[h>>2]|0)+(6+(c[j>>2]|0)<<2)>>2]*1.0)/4.0;c[j>>2]=(c[j>>2]|0)+1}g[(c[h>>2]|0)+108>>2]=1.0;g[(c[h>>2]|0)+112>>2]=1.0;g[(c[h>>2]|0)+116>>2]=0.0;c[c[f>>2]>>2]=10;i=d;return c[h>>2]|0}function Ud(d,e){d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0;f=i;i=i+32|0;g=f+20|0;h=f+16|0;j=f+12|0;k=f+8|0;l=f+4|0;m=f;c[f+24>>2]=d;c[g>>2]=e;c[h>>2]=c[c[g>>2]>>2];c[j>>2]=c[(c[g>>2]|0)+4>>2];c[k>>2]=$(c[h>>2]|0,c[j>>2]|0)|0;c[l>>2]=me(36)|0;c[(c[l>>2]|0)+8>>2]=0;c[(c[l>>2]|0)+20>>2]=0;a[(c[l>>2]|0)+24|0]=0;c[(c[l>>2]|0)+32>>2]=-1;c[(c[l>>2]|0)+28>>2]=-1;j=c[l>>2]|0;h=c[g>>2]|0;c[j+0>>2]=c[h+0>>2];c[j+4>>2]=c[h+4>>2];a[(c[l>>2]|0)+12|0]=0;h=me(c[k>>2]<<1)|0;c[(c[l>>2]|0)+16>>2]=h;c[m>>2]=0;while(1){if((c[m>>2]|0)>=(c[k>>2]|0)){break}b[(c[(c[l>>2]|0)+16>>2]|0)+(c[m>>2]<<1)>>1]=63;c[m>>2]=(c[m>>2]|0)+1}i=f;return c[l>>2]|0}function Vd(a,b){a=a|0;b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;c[e>>2]=a;c[f>>2]=b;if((c[(c[f>>2]|0)+20>>2]|0)!=0){wc(c[e>>2]|0,c[(c[f>>2]|0)+20>>2]|0)}ne(c[(c[f>>2]|0)+16>>2]|0);ne(c[f>>2]|0);i=d;return}function Wd(f,h,j,k,l,m,n,o){f=f|0;h=h|0;j=j|0;k=k|0;l=l|0;m=m|0;n=+n;o=+o;var p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0;p=i;i=i+368|0;q=p;r=p+96|0;s=p+92|0;t=p+88|0;u=p+84|0;v=p+80|0;w=p+76|0;x=p+72|0;y=p+68|0;z=p+64|0;A=p+60|0;B=p+56|0;C=p+52|0;D=p+48|0;E=p+44|0;F=p+40|0;G=p+36|0;H=p+32|0;I=p+104|0;J=p+28|0;K=p+24|0;L=p+100|0;M=p+20|0;N=p+16|0;P=p+12|0;Q=p+8|0;R=p+4|0;c[r>>2]=f;c[s>>2]=h;c[t>>2]=j;c[u>>2]=k;c[v>>2]=l;c[w>>2]=m;g[x>>2]=n;g[y>>2]=o;c[z>>2]=c[c[u>>2]>>2];c[A>>2]=c[(c[u>>2]|0)+4>>2];if(+g[y>>2]!=0.0?((~~(+g[y>>2]*3.0/.30000001192092896)|0)%2|0|0)==0:0){c[F>>2]=c[(c[w>>2]|0)+4>>2]}else{c[F>>2]=0}do{if(a[(c[s>>2]|0)+24|0]&1){if((c[(c[s>>2]|0)+20>>2]|0)!=0){yc(c[r>>2]|0,c[(c[s>>2]|0)+20>>2]|0,c[(c[s>>2]|0)+28>>2]|0,c[(c[s>>2]|0)+32>>2]|0);pc(c[r>>2]|0,c[(c[s>>2]|0)+28>>2]|0,c[(c[s>>2]|0)+32>>2]|0,c[(c[s>>2]|0)+8>>2]|0,c[(c[s>>2]|0)+8>>2]|0);a[(c[s>>2]|0)+24|0]=0;break}else{Ga(816,840,2001,856)}}}while(0);if(!(a[(c[s>>2]|0)+12|0]&1)){Rd(c[s>>2]|0,c[(c[s>>2]|0)+8>>2]|0,J,K);lc(c[r>>2]|0,0,0,c[J>>2]|0,c[K>>2]|0,0);pc(c[r>>2]|0,0,0,c[J>>2]|0,c[K>>2]|0);c[C>>2]=0;while(1){if((c[C>>2]|0)>(c[A>>2]|0)){break}K=$(c[C>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;J=$(c[z>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;y=$(c[C>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;mc(c[r>>2]|0,0+(c[(c[s>>2]|0)+8>>2]|0)|0,K+(c[(c[s>>2]|0)+8>>2]|0)|0,J+(c[(c[s>>2]|0)+8>>2]|0)|0,y+(c[(c[s>>2]|0)+8>>2]|0)|0,3);c[C>>2]=(c[C>>2]|0)+1}c[B>>2]=0;while(1){if((c[B>>2]|0)>(c[z>>2]|0)){break}y=$(c[B>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;J=$(c[B>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;K=$(c[A>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;mc(c[r>>2]|0,y+(c[(c[s>>2]|0)+8>>2]|0)|0,0+(c[(c[s>>2]|0)+8>>2]|0)|0,J+(c[(c[s>>2]|0)+8>>2]|0)|0,K+(c[(c[s>>2]|0)+8>>2]|0)|0,3);c[B>>2]=(c[B>>2]|0)+1}a[(c[s>>2]|0)+12|0]=1}if((c[t>>2]|0)!=0){g[D>>2]=+g[x>>2]/+g[c[w>>2]>>2];c[E>>2]=~~(+g[D>>2]*+(c[((c[v>>2]|0)>0?c[u>>2]|0:c[t>>2]|0)+24>>2]|0))}else{c[E>>2]=0;g[D>>2]=0.0}c[G>>2]=0;c[C>>2]=0;while(1){if((c[C>>2]|0)>=(c[A>>2]|0)){break}c[B>>2]=0;while(1){S=c[C>>2]|0;if((c[B>>2]|0)>=(c[z>>2]|0)){break}v=$(S,c[z>>2]|0)|0;b[L>>1]=d[(c[(c[u>>2]|0)+20>>2]|0)+(v+(c[B>>2]|0))|0]|0;do{if((c[t>>2]|0)!=0?(v=$(c[C>>2]|0,c[z>>2]|0)|0,x=$(c[C>>2]|0,c[z>>2]|0)|0,(a[(c[(c[t>>2]|0)+20>>2]|0)+(v+(c[B>>2]|0))|0]|0)!=(a[(c[(c[u>>2]|0)+20>>2]|0)+(x+(c[B>>2]|0))|0]|0)):0){x=O((c[B>>2]|0)-(c[(c[t>>2]|0)+8>>2]|0)|0)|0;if((x|0)>(O((c[C>>2]|0)-(c[(c[t>>2]|0)+12>>2]|0)|0)|0)){T=O((c[B>>2]|0)-(c[(c[t>>2]|0)+8>>2]|0)|0)|0}else{T=O((c[C>>2]|0)-(c[(c[t>>2]|0)+12>>2]|0)|0)|0}c[M>>2]=T;x=$(c[C>>2]|0,c[z>>2]|0)|0;v=x+(c[B>>2]|0)|0;if((c[E>>2]|0)<(c[M>>2]|0)){b[L>>1]=a[(c[(c[t>>2]|0)+20>>2]|0)+v|0]|0;break}else{b[L>>1]=a[(c[(c[u>>2]|0)+20>>2]|0)+v|0]|0;break}}}while(0);if(((((e[L>>1]|0)==109?(c[t>>2]|0)==0:0)?a[(c[u>>2]|0)+28|0]&1:0)?(c[B>>2]|0)==(c[(c[u>>2]|0)+8>>2]|0):0)?(c[C>>2]|0)==(c[(c[u>>2]|0)+12>>2]|0):0){b[L>>1]=98}if((e[L>>1]|0)==103){c[G>>2]=(c[G>>2]|0)+1}b[L>>1]=e[L>>1]|c[F>>2];v=$(c[C>>2]|0,c[z>>2]|0)|0;if((e[(c[(c[s>>2]|0)+16>>2]|0)+(v+(c[B>>2]|0)<<1)>>1]|0)!=(e[L>>1]|0)){be(c[r>>2]|0,c[s>>2]|0,c[B>>2]|0,c[C>>2]|0,e[L>>1]|0);v=$(c[C>>2]|0,c[z>>2]|0)|0;b[(c[(c[s>>2]|0)+16>>2]|0)+(v+(c[B>>2]|0)<<1)>>1]=b[L>>1]|0}c[B>>2]=(c[B>>2]|0)+1}c[C>>2]=S+1}do{if(a[(c[u>>2]|0)+28|0]&1){if((c[t>>2]|0)!=0?!(a[(c[t>>2]|0)+28|0]&1):0){U=48;break}fb(I|0,872,q|0)|0}else{U=48}}while(0);a:do{if((U|0)==48){do{if((c[(c[u>>2]|0)+16>>2]|0)==0){if((c[t>>2]|0)!=0?(c[(c[t>>2]|0)+16>>2]|0)!=0:0){break}if(a[(c[u>>2]|0)+29|0]&1){fb(I|0,920,q|0)|0;break a}else{fb(I|0,936,q|0)|0;break a}}}while(0);if(a[(c[u>>2]|0)+29|0]&1){fb(I|0,880,q|0)|0}else{a[I]=0}S=I+(dg(I|0)|0)|0;c[q>>2]=c[G>>2];fb(S|0,904,q|0)|0}}while(0);c[H>>2]=c[(c[w>>2]|0)+8>>2];do{if((c[t>>2]|0)!=0?a[(c[w>>2]|0)+13|0]&1:0){if((c[H>>2]|0)>0){c[H>>2]=(c[H>>2]|0)+ -1;break}else{Ga(952,840,2125,856)}}}while(0);if((c[H>>2]|0)!=0){w=I+(dg(I|0)|0)|0;c[q>>2]=c[H>>2];fb(w|0,968,q|0)|0}uc(c[r>>2]|0,I);if(a[(c[s>>2]|0)+24|0]&1){Ga(984,840,2135,856)}if((c[(c[s>>2]|0)+20>>2]|0)==0){Ga(816,840,2136,856)}I=$(c[(c[u>>2]|0)+8>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;c[Q>>2]=I+(c[(c[s>>2]|0)+8>>2]|0);I=$(c[(c[u>>2]|0)+12>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;c[R>>2]=I+(c[(c[s>>2]|0)+8>>2]|0);if((c[t>>2]|0)!=0){I=$(c[(c[t>>2]|0)+8>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;c[N>>2]=I+(c[(c[s>>2]|0)+8>>2]|0);I=$(c[(c[t>>2]|0)+12>>2]|0,c[(c[s>>2]|0)+8>>2]|0)|0;c[P>>2]=I+(c[(c[s>>2]|0)+8>>2]|0)}else{c[N>>2]=c[Q>>2];c[P>>2]=c[R>>2]}c[(c[s>>2]|0)+28>>2]=~~(+(c[N>>2]|0)+ +g[D>>2]*+((c[Q>>2]|0)-(c[N>>2]|0)|0));c[(c[s>>2]|0)+32>>2]=~~(+(c[P>>2]|0)+ +g[D>>2]*+((c[R>>2]|0)-(c[P>>2]|0)|0));xc(c[r>>2]|0,c[(c[s>>2]|0)+20>>2]|0,c[(c[s>>2]|0)+28>>2]|0,c[(c[s>>2]|0)+32>>2]|0);P=c[r>>2]|0;r=c[s>>2]|0;R=c[(c[s>>2]|0)+28>>2]|0;D=c[(c[s>>2]|0)+32>>2]|0;if(a[(c[u>>2]|0)+28|0]&1){V=(c[t>>2]|0)!=0^1}else{V=0}if((c[t>>2]|0)!=0){W=-1;ce(P,r,R,D,V,W);X=c[s>>2]|0;Y=X+24|0;a[Y]=1;i=p;return}if((c[(c[u>>2]|0)+36>>2]|0)==0){W=-1;ce(P,r,R,D,V,W);X=c[s>>2]|0;Y=X+24|0;a[Y]=1;i=p;return}W=d[(c[(c[(c[u>>2]|0)+36>>2]|0)+8>>2]|0)+(c[(c[u>>2]|0)+32>>2]|0)|0]|0;ce(P,r,R,D,V,W);X=c[s>>2]|0;Y=X+24|0;a[Y]=1;i=p;return}function Xd(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,h=0,j=0,k=0,l=0,m=0,n=0.0;f=i;i=i+32|0;h=f+16|0;j=f+12|0;k=f+8|0;l=f+4|0;m=f;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;if((c[k>>2]|0)>0){c[m>>2]=c[(c[j>>2]|0)+24>>2]}else{c[m>>2]=c[(c[h>>2]|0)+24>>2]}n=+P(+(+(c[m>>2]|0)))*.10000000149011612;g[c[l>>2]>>2]=n;i=f;return+(+g[c[l>>2]>>2])}function Yd(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var h=0,j=0,k=0,l=0,m=0,n=0.0;h=i;i=i+32|0;j=h+16|0;k=h+12|0;l=h+8|0;m=h;c[k>>2]=b;c[l>>2]=d;c[h+4>>2]=e;c[m>>2]=f;if(!(a[(c[k>>2]|0)+28|0]&1)?a[(c[l>>2]|0)+28|0]&1:0){c[(c[m>>2]|0)+4>>2]=256;g[j>>2]=.30000001192092896;n=+g[j>>2];i=h;return+n}if((c[(c[k>>2]|0)+16>>2]|0)!=0?(c[(c[l>>2]|0)+16>>2]|0)==0:0){c[(c[m>>2]|0)+4>>2]=512;g[j>>2]=.30000001192092896;n=+g[j>>2];i=h;return+n}g[j>>2]=0.0;n=+g[j>>2];i=h;return+n}function Zd(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;i=b;return((c[(c[d>>2]|0)+16>>2]|0)==0?1:0)|0}function _d(a,b,d){a=a|0;b=b|0;d=d|0;var e=0;e=i;i=i+16|0;c[e+8>>2]=a;c[e+4>>2]=b;c[e>>2]=d;i=e;return}function $d(a,b,d){a=a|0;b=b|0;d=d|0;var e=0;e=i;i=i+16|0;c[e+8>>2]=a;c[e+4>>2]=b;c[e>>2]=d;i=e;return}function ae(a,b){a=a|0;b=b|0;var d=0;d=i;i=i+16|0;c[d+4>>2]=a;c[d>>2]=b;i=d;return 1}function be(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0;g=i;i=i+112|0;h=g+100|0;j=g+96|0;k=g+92|0;l=g+88|0;m=g+84|0;n=g+80|0;o=g+76|0;p=g+72|0;q=g+48|0;r=g+40|0;s=g+36|0;t=g+32|0;u=g;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;f=$(c[k>>2]|0,c[(c[j>>2]|0)+8>>2]|0)|0;c[n>>2]=f+(c[(c[j>>2]|0)+8>>2]|0);f=$(c[l>>2]|0,c[(c[j>>2]|0)+8>>2]|0)|0;c[o>>2]=f+(c[(c[j>>2]|0)+8>>2]|0);if((c[m>>2]&256|0)!=0){v=5}else{v=(c[m>>2]&512|0)!=0?2:0}c[p>>2]=v;c[m>>2]=c[m>>2]&-769;qc(c[h>>2]|0,(c[n>>2]|0)+1|0,(c[o>>2]|0)+1|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0);lc(c[h>>2]|0,(c[n>>2]|0)+1|0,(c[o>>2]|0)+1|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0,c[p>>2]|0);if((c[m>>2]|0)==119){c[q>>2]=(c[n>>2]|0)+(c[(c[j>>2]|0)+8>>2]|0);c[q+4>>2]=(c[o>>2]|0)+(c[(c[j>>2]|0)+8>>2]|0);c[q+8>>2]=(c[n>>2]|0)+(c[(c[j>>2]|0)+8>>2]|0);c[q+12>>2]=(c[o>>2]|0)+1;c[q+16>>2]=(c[n>>2]|0)+1;c[q+20>>2]=(c[o>>2]|0)+(c[(c[j>>2]|0)+8>>2]|0);nc(c[h>>2]|0,q,3,3,3);c[q>>2]=(c[n>>2]|0)+1;c[q+4>>2]=(c[o>>2]|0)+1;nc(c[h>>2]|0,q,3,2,2);lc(c[h>>2]|0,(c[n>>2]|0)+1+((c[(c[j>>2]|0)+8>>2]|0)/10|0)|0,(c[o>>2]|0)+1+((c[(c[j>>2]|0)+8>>2]|0)/10|0)|0,(c[(c[j>>2]|0)+8>>2]|0)-(((c[(c[j>>2]|0)+8>>2]|0)/10|0)<<1)|0,(c[(c[j>>2]|0)+8>>2]|0)-(((c[(c[j>>2]|0)+8>>2]|0)/10|0)<<1)|0,8);w=c[h>>2]|0;rc(w);x=c[h>>2]|0;y=c[n>>2]|0;z=c[o>>2]|0;A=c[j>>2]|0;B=A+8|0;C=c[B>>2]|0;D=c[j>>2]|0;E=D+8|0;F=c[E>>2]|0;pc(x,y,z,C,F);i=g;return}if((c[m>>2]|0)==109){c[r>>2]=(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);c[s>>2]=(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);c[t>>2]=((c[(c[j>>2]|0)+8>>2]|0)/2|0)-3;oc(c[h>>2]|0,c[r>>2]|0,c[s>>2]|0,((c[t>>2]|0)*5|0)/6|0,6,6);lc(c[h>>2]|0,(c[r>>2]|0)-((c[t>>2]|0)/6|0)|0,(c[s>>2]|0)-(c[t>>2]|0)|0,(((c[t>>2]|0)/6|0)<<1)+1|0,(c[t>>2]<<1)+1|0,6);lc(c[h>>2]|0,(c[r>>2]|0)-(c[t>>2]|0)|0,(c[s>>2]|0)-((c[t>>2]|0)/6|0)|0,(c[t>>2]<<1)+1|0,(((c[t>>2]|0)/6|0)<<1)+1|0,6);lc(c[h>>2]|0,(c[r>>2]|0)-((c[t>>2]|0)/3|0)|0,(c[s>>2]|0)-((c[t>>2]|0)/3|0)|0,(c[t>>2]|0)/3|0,(c[t>>2]|0)/4|0,2);w=c[h>>2]|0;rc(w);x=c[h>>2]|0;y=c[n>>2]|0;z=c[o>>2]|0;A=c[j>>2]|0;B=A+8|0;C=c[B>>2]|0;D=c[j>>2]|0;E=D+8|0;F=c[E>>2]|0;pc(x,y,z,C,F);i=g;return}if((c[m>>2]|0)==115){oc(c[h>>2]|0,(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)|0,(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)|0,((c[(c[j>>2]|0)+8>>2]|0)*3|0)/7|0,-1,1);lc(c[h>>2]|0,(c[n>>2]|0)+(((c[(c[j>>2]|0)+8>>2]|0)*3|0)/7|0)|0,(c[o>>2]|0)+1|0,(c[(c[j>>2]|0)+8>>2]|0)-((((c[(c[j>>2]|0)+8>>2]|0)*3|0)/7|0)<<1)+1|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0,c[p>>2]|0);lc(c[h>>2]|0,(c[n>>2]|0)+1|0,(c[o>>2]|0)+(((c[(c[j>>2]|0)+8>>2]|0)*3|0)/7|0)|0,(c[(c[j>>2]|0)+8>>2]|0)-1|0,(c[(c[j>>2]|0)+8>>2]|0)-((((c[(c[j>>2]|0)+8>>2]|0)*3|0)/7|0)<<1)+1|0,c[p>>2]|0);w=c[h>>2]|0;rc(w);x=c[h>>2]|0;y=c[n>>2]|0;z=c[o>>2]|0;A=c[j>>2]|0;B=A+8|0;C=c[B>>2]|0;D=c[j>>2]|0;E=D+8|0;F=c[E>>2]|0;pc(x,y,z,C,F);i=g;return}if((c[m>>2]|0)!=103){w=c[h>>2]|0;rc(w);x=c[h>>2]|0;y=c[n>>2]|0;z=c[o>>2]|0;A=c[j>>2]|0;B=A+8|0;C=c[B>>2]|0;D=c[j>>2]|0;E=D+8|0;F=c[E>>2]|0;pc(x,y,z,C,F);i=g;return}c[u>>2]=(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);c[u+4>>2]=(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)-(((c[(c[j>>2]|0)+8>>2]|0)*5|0)/14|0);c[u+8>>2]=(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)-(((c[(c[j>>2]|0)+8>>2]|0)*5|0)/14|0);c[u+12>>2]=(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);c[u+16>>2]=(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);c[u+20>>2]=(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)+(((c[(c[j>>2]|0)+8>>2]|0)*5|0)/14|0);c[u+24>>2]=(c[n>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0)+(((c[(c[j>>2]|0)+8>>2]|0)*5|0)/14|0);c[u+28>>2]=(c[o>>2]|0)+((c[(c[j>>2]|0)+8>>2]|0)/2|0);nc(c[h>>2]|0,u,4,7,1);w=c[h>>2]|0;rc(w);x=c[h>>2]|0;y=c[n>>2]|0;z=c[o>>2]|0;A=c[j>>2]|0;B=A+8|0;C=c[B>>2]|0;D=c[j>>2]|0;E=D+8|0;F=c[E>>2]|0;pc(x,y,z,C,F);i=g;return}function ce(b,d,e,f,h,j){b=b|0;d=d|0;e=e|0;f=f|0;h=h|0;j=j|0;var k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0;k=i;i=i+288|0;l=k+272|0;m=k+268|0;n=k+264|0;o=k+260|0;p=k+276|0;q=k+256|0;r=k+128|0;s=k+120|0;t=k+116|0;u=k+112|0;v=k+108|0;w=k+104|0;x=k+100|0;y=k+96|0;z=k+92|0;A=k+88|0;B=k+84|0;C=k+80|0;D=k+76|0;E=k+72|0;F=k+68|0;G=k+64|0;H=k+8|0;I=k;c[l>>2]=b;c[m>>2]=d;c[n>>2]=e;c[o>>2]=f;a[p]=h&1;c[q>>2]=j;if(a[p]&1){c[s>>2]=0;while(1){if((c[s>>2]|0)>=8){break}if((c[s>>2]&3|0)!=0){J=(c[s>>2]&7|0)>4?-1:1}else{J=0}g[t>>2]=+(J|0);if(((c[s>>2]|0)+6&3|0)!=0){K=((c[s>>2]|0)+6&7|0)>4?-1:1}else{K=0}g[u>>2]=+(K|0);g[z>>2]=+P(+(+g[t>>2]*+g[t>>2]+ +g[u>>2]*+g[u>>2]));g[t>>2]=+g[t>>2]/+g[z>>2];g[u>>2]=+g[u>>2]/+g[z>>2];if(((c[s>>2]|0)+1&3|0)!=0){L=((c[s>>2]|0)+1&7|0)>4?-1:1}else{L=0}g[x>>2]=+(L|0);if(((c[s>>2]|0)+7&3|0)!=0){M=((c[s>>2]|0)+7&7|0)>4?-1:1}else{M=0}g[y>>2]=+(M|0);g[z>>2]=+P(+(+g[x>>2]*+g[x>>2]+ +g[y>>2]*+g[y>>2]));g[x>>2]=+g[x>>2]/+g[z>>2];g[y>>2]=+g[y>>2]/+g[z>>2];g[v>>2]=(+g[t>>2]+ +g[x>>2])/4.0;g[w>>2]=(+g[u>>2]+ +g[y>>2])/4.0;c[r+((c[s>>2]<<2)+0<<2)>>2]=(c[n>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)+~~(+(((c[(c[m>>2]|0)+8>>2]|0)*3|0)/7|0|0)*+g[t>>2]);c[r+((c[s>>2]<<2)+1<<2)>>2]=(c[o>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)+~~(+(((c[(c[m>>2]|0)+8>>2]|0)*3|0)/7|0|0)*+g[u>>2]);c[r+((c[s>>2]<<2)+2<<2)>>2]=(c[n>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)+~~(+(((c[(c[m>>2]|0)+8>>2]|0)*3|0)/7|0|0)*+g[v>>2]);c[r+((c[s>>2]<<2)+3<<2)>>2]=(c[o>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)+~~(+(((c[(c[m>>2]|0)+8>>2]|0)*3|0)/7|0|0)*+g[w>>2]);c[s>>2]=(c[s>>2]|0)+1}nc(c[l>>2]|0,r,16,5,1)}else{oc(c[l>>2]|0,(c[n>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)|0,(c[o>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0)|0,(c[(c[m>>2]|0)+8>>2]|0)/3|0,4,1)}if(a[p]&1){N=c[l>>2]|0;O=c[n>>2]|0;Q=c[o>>2]|0;R=c[m>>2]|0;S=R+8|0;T=c[S>>2]|0;U=c[m>>2]|0;V=U+8|0;W=c[V>>2]|0;pc(N,O,Q,T,W);i=k;return}if((c[q>>2]|0)<0){N=c[l>>2]|0;O=c[n>>2]|0;Q=c[o>>2]|0;R=c[m>>2]|0;S=R+8|0;T=c[S>>2]|0;U=c[m>>2]|0;V=U+8|0;W=c[V>>2]|0;pc(N,O,Q,T,W);i=k;return}if((c[q>>2]&3|0)!=0){if(((c[q>>2]|0)+6&3|0)!=0){X=((c[q>>2]|0)+6&7|0)>4?-1:1}else{X=0}Y=(X|0)!=0}else{Y=0}g[A>>2]=Y?.800000011920929:1.0;if((c[q>>2]&3|0)!=0){Z=(c[q>>2]&7|0)>4?-1:1}else{Z=0}c[B>>2]=~~(+((c[(c[m>>2]|0)+8>>2]<<1|0)/5|0|0)*+g[A>>2]*+(Z|0));if(((c[q>>2]|0)+6&3|0)!=0){_=((c[q>>2]|0)+6&7|0)>4?-1:1}else{_=0}c[C>>2]=~~(+((c[(c[m>>2]|0)+8>>2]<<1|0)/5|0|0)*+g[A>>2]*+(_|0));c[D>>2]=0-(c[C>>2]|0);c[E>>2]=c[B>>2];c[F>>2]=(c[n>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0);c[G>>2]=(c[o>>2]|0)+((c[(c[m>>2]|0)+8>>2]|0)/2|0);c[I>>2]=H;_=(c[F>>2]|0)+((c[D>>2]|0)/9|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[G>>2]|0)+((c[E>>2]|0)/9|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[F>>2]|0)+((c[D>>2]|0)/9|0)+((c[B>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[G>>2]|0)+((c[E>>2]|0)/9|0)+((c[C>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[F>>2]|0)+((c[D>>2]|0)/3|0)+((c[B>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[G>>2]|0)+((c[E>>2]|0)/3|0)+((c[C>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[F>>2]|0)+(c[B>>2]|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[G>>2]|0)+(c[C>>2]|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[F>>2]|0)-((c[D>>2]|0)/3|0)+((c[B>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[G>>2]|0)-((c[E>>2]|0)/3|0)+((c[C>>2]<<1|0)/3|0)|0;A=c[I>>2]|0;c[I>>2]=A+4;c[A>>2]=_;_=(c[F>>2]|0)-((c[D>>2]|0)/9|0)+((c[B>>2]<<1|0)/3|0)|0;B=c[I>>2]|0;c[I>>2]=B+4;c[B>>2]=_;_=(c[G>>2]|0)-((c[E>>2]|0)/9|0)+((c[C>>2]<<1|0)/3|0)|0;C=c[I>>2]|0;c[I>>2]=C+4;c[C>>2]=_;_=(c[F>>2]|0)-((c[D>>2]|0)/9|0)|0;D=c[I>>2]|0;c[I>>2]=D+4;c[D>>2]=_;_=(c[G>>2]|0)-((c[E>>2]|0)/9|0)|0;E=c[I>>2]|0;c[I>>2]=E+4;c[E>>2]=_;nc(c[l>>2]|0,H,7,9,1);N=c[l>>2]|0;O=c[n>>2]|0;Q=c[o>>2]|0;R=c[m>>2]|0;S=R+8|0;T=c[S>>2]|0;U=c[m>>2]|0;V=U+8|0;W=c[V>>2]|0;pc(N,O,Q,T,W);i=k;return}function de(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+16|0;f=e+12|0;g=e+8|0;h=e+4|0;j=e;c[f>>2]=b;c[g>>2]=d;if((a[c[g>>2]|0]|0)!=83){Ga(1160,840,1649,1176)}c[g>>2]=(c[g>>2]|0)+1;c[j>>2]=me(12)|0;d=dg(c[g>>2]|0)|0;c[(c[j>>2]|0)+4>>2]=d;d=me(c[(c[j>>2]|0)+4>>2]|0)|0;c[(c[j>>2]|0)+8>>2]=d;c[h>>2]=0;while(1){if((c[h>>2]|0)>=(c[(c[j>>2]|0)+4>>2]|0)){break}a[(c[(c[j>>2]|0)+8>>2]|0)+(c[h>>2]|0)|0]=(a[(c[g>>2]|0)+(c[h>>2]|0)|0]|0)-48;c[h>>2]=(c[h>>2]|0)+1}if((c[(c[f>>2]|0)+36>>2]|0)!=0?(h=c[(c[f>>2]|0)+36>>2]|0,g=(c[h>>2]|0)+ -1|0,c[h>>2]=g,(g|0)==0):0){ne(c[(c[(c[f>>2]|0)+36>>2]|0)+8>>2]|0);ne(c[(c[f>>2]|0)+36>>2]|0)}c[(c[f>>2]|0)+36>>2]=c[j>>2];c[c[j>>2]>>2]=1;a[(c[f>>2]|0)+29|0]=1;c[(c[f>>2]|0)+32>>2]=0;i=e;return}function ee(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;a=c[(c[d>>2]|0)+36>>2]|0;c[a>>2]=(c[a>>2]|0)+ -1;if((c[c[(c[d>>2]|0)+36>>2]>>2]|0)>0){c[(c[d>>2]|0)+36>>2]=0;c[(c[d>>2]|0)+32>>2]=0;i=b;return}else{Ga(1112,840,1672,1136)}}function fe(b,d,e,f,g,h){b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;var j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0;j=i;i=i+32|0;k=j+28|0;l=j+24|0;m=j+20|0;n=j+16|0;o=j+12|0;p=j+8|0;q=j+4|0;r=j;c[l>>2]=b;c[m>>2]=d;c[n>>2]=e;c[o>>2]=f;c[p>>2]=g;c[q>>2]=h;c[r>>2]=-1;while(1){if((c[q>>2]&3|0)!=0){s=(c[q>>2]&7|0)>4?-1:1}else{s=0}if(((c[o>>2]|0)+s|0)>=0){if((c[q>>2]&3|0)!=0){t=(c[q>>2]&7|0)>4?-1:1}else{t=0}if(((c[o>>2]|0)+t|0)<(c[l>>2]|0)){if(((c[q>>2]|0)+6&3|0)!=0){u=((c[q>>2]|0)+6&7|0)>4?-1:1}else{u=0}if(((c[p>>2]|0)+u|0)>=0){if(((c[q>>2]|0)+6&3|0)!=0){v=((c[q>>2]|0)+6&7|0)>4?-1:1}else{v=0}if(((c[p>>2]|0)+v|0)<(c[m>>2]|0)){if(((c[q>>2]|0)+6&3|0)!=0){w=((c[q>>2]|0)+6&7|0)>4?-1:1}else{w=0}h=$((c[p>>2]|0)+w|0,c[l>>2]|0)|0;if((c[q>>2]&3|0)!=0){x=(c[q>>2]&7|0)>4?-1:1}else{x=0}y=a[(c[n>>2]|0)+(h+((c[o>>2]|0)+x))|0]|0}else{y=119}}else{y=119}}else{y=119}}else{y=119}if((y|0)==119){z=20;break}if((c[q>>2]&3|0)!=0){A=(c[q>>2]&7|0)>4?-1:1}else{A=0}c[o>>2]=(c[o>>2]|0)+A;if(((c[q>>2]|0)+6&3|0)!=0){B=((c[q>>2]|0)+6&7|0)>4?-1:1}else{B=0}c[p>>2]=(c[p>>2]|0)+B;if((((c[o>>2]|0)>=0?(c[o>>2]|0)<(c[l>>2]|0):0)?(c[p>>2]|0)>=0:0)?(c[p>>2]|0)<(c[m>>2]|0):0){h=$(c[p>>2]|0,c[l>>2]|0)|0;C=a[(c[n>>2]|0)+(h+(c[o>>2]|0))|0]|0}else{C=119}if((C|0)==115){z=31;break}if((((c[o>>2]|0)>=0?(c[o>>2]|0)<(c[l>>2]|0):0)?(c[p>>2]|0)>=0:0)?(c[p>>2]|0)<(c[m>>2]|0):0){h=$(c[p>>2]|0,c[l>>2]|0)|0;D=a[(c[n>>2]|0)+(h+(c[o>>2]|0))|0]|0}else{D=119}if((D|0)==103){z=38;break}if((((c[o>>2]|0)>=0?(c[o>>2]|0)<(c[l>>2]|0):0)?(c[p>>2]|0)>=0:0)?(c[p>>2]|0)<(c[m>>2]|0):0){h=$(c[p>>2]|0,c[l>>2]|0)|0;E=a[(c[n>>2]|0)+(h+(c[o>>2]|0))|0]|0}else{E=119}if((E|0)==109){z=45;break}}if((z|0)==20){c[r>>2]=8}else if((z|0)==31){c[r>>2]=8}else if((z|0)==38){c[r>>2]=c[q>>2]}else if((z|0)==45){c[k>>2]=-1;F=c[k>>2]|0;i=j;return F|0}if((c[r>>2]|0)<0){Ga(1640,840,714,1648)}z=$(c[p>>2]|0,c[l>>2]|0)|0;c[k>>2]=((z+(c[o>>2]|0)|0)*9|0)+(c[r>>2]|0);F=c[k>>2]|0;i=j;return F|0}function ge(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0;d=i;i=i+32|0;e=d+16|0;f=d+12|0;g=d+8|0;h=d+4|0;j=d;c[f>>2]=a;c[g>>2]=b;c[h>>2]=c[f>>2];c[j>>2]=c[g>>2];if((c[c[h>>2]>>2]|0)<(c[c[j>>2]>>2]|0)){c[e>>2]=-1;k=c[e>>2]|0;i=d;return k|0}if((c[c[h>>2]>>2]|0)>(c[c[j>>2]>>2]|0)){c[e>>2]=1;k=c[e>>2]|0;i=d;return k|0}else{c[e>>2]=0;k=c[e>>2]|0;i=d;return k|0}return 0}function he(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0;f=i;i=i+96|0;g=f+88|0;h=f+84|0;j=f+80|0;k=f+76|0;l=f+72|0;m=f+68|0;n=f+64|0;o=f+60|0;p=f+56|0;q=f+52|0;r=f+48|0;s=f+44|0;t=f+40|0;u=f+36|0;v=f+32|0;w=f+28|0;x=f+24|0;y=f+20|0;z=f+16|0;A=f+12|0;B=f+8|0;C=f+4|0;D=f;c[g>>2]=b;c[h>>2]=d;c[j>>2]=e;c[k>>2]=$(c[g>>2]|0,c[h>>2]|0)|0;c[l>>2]=me((c[k>>2]|0)+1|0)|0;c[m>>2]=ie(c[g>>2]|0,c[h>>2]|0)|0;c[n>>2]=2;c[o>>2]=0;while(1){c[p>>2]=0;c[q>>2]=0;while(1){if((c[q>>2]|0)>=((c[k>>2]|0)/5|0|0)){break}e=c[p>>2]|0;c[p>>2]=e+1;a[(c[l>>2]|0)+e|0]=119;c[q>>2]=(c[q>>2]|0)+1}c[q>>2]=0;while(1){if((c[q>>2]|0)>=((c[k>>2]|0)/5|0|0)){break}e=c[p>>2]|0;c[p>>2]=e+1;a[(c[l>>2]|0)+e|0]=115;c[q>>2]=(c[q>>2]|0)+1}c[q>>2]=0;while(1){E=c[p>>2]|0;if((c[q>>2]|0)>=((c[k>>2]|0)/5|0|0)){break}c[p>>2]=E+1;a[(c[l>>2]|0)+E|0]=109;c[q>>2]=(c[q>>2]|0)+1}if((E|0)>=(c[k>>2]|0)){F=12;break}e=c[p>>2]|0;c[p>>2]=e+1;a[(c[l>>2]|0)+e|0]=83;while(1){if((c[p>>2]|0)>=(c[k>>2]|0)){break}e=c[p>>2]|0;c[p>>2]=e+1;a[(c[l>>2]|0)+e|0]=98}qf(c[l>>2]|0,c[k>>2]|0,1,c[j>>2]|0);c[r>>2]=je(c[g>>2]|0,c[h>>2]|0,c[l>>2]|0,c[m>>2]|0)|0;if((c[r>>2]|0)<((c[k>>2]|0)/5|0|0)){continue}c[s>>2]=c[(c[m>>2]|0)+8>>2];c[t>>2]=(c[(c[m>>2]|0)+8>>2]|0)+(c[k>>2]<<2);c[p>>2]=0;while(1){if((c[p>>2]|0)>=(c[k>>2]|0)){break}c[(c[s>>2]|0)+(c[p>>2]<<2)>>2]=-1;c[p>>2]=(c[p>>2]|0)+1}c[v>>2]=0;c[u>>2]=0;c[p>>2]=0;while(1){if((c[p>>2]|0)>=(c[k>>2]|0)){break}if((a[(c[l>>2]|0)+(c[p>>2]|0)|0]|0)==71){c[(c[s>>2]|0)+(c[p>>2]<<2)>>2]=0;e=c[p>>2]|0;d=c[v>>2]|0;c[v>>2]=d+1;c[(c[t>>2]|0)+(d<<2)>>2]=e}c[p>>2]=(c[p>>2]|0)+1}c[w>>2]=0;a:while(1){G=c[u>>2]|0;if((c[u>>2]|0)>=(c[v>>2]|0)){break}c[u>>2]=G+1;c[x>>2]=c[(c[t>>2]|0)+(G<<2)>>2];if((c[w>>2]|0)<(c[(c[s>>2]|0)+(c[x>>2]<<2)>>2]|0)){c[w>>2]=c[(c[s>>2]|0)+(c[x>>2]<<2)>>2]}c[y>>2]=(c[x>>2]|0)%(c[g>>2]|0)|0;c[z>>2]=(c[x>>2]|0)/(c[g>>2]|0)|0;c[A>>2]=0;while(1){if((c[A>>2]|0)>=8){continue a}if((c[A>>2]&3|0)!=0){H=(c[A>>2]&7|0)>4?-1:1}else{H=0}c[B>>2]=(c[y>>2]|0)+H;if(((c[A>>2]|0)+6&3|0)!=0){I=((c[A>>2]|0)+6&7|0)>4?-1:1}else{I=0}c[C>>2]=(c[z>>2]|0)+I;if(((((c[B>>2]|0)>=0?(c[B>>2]|0)<(c[g>>2]|0):0)?(c[C>>2]|0)>=0:0)?(c[C>>2]|0)<(c[h>>2]|0):0)?(e=$(c[C>>2]|0,c[g>>2]|0)|0,c[D>>2]=e+(c[B>>2]|0),(c[(c[s>>2]|0)+(c[D>>2]<<2)>>2]|0)<0):0){c[(c[s>>2]|0)+(c[D>>2]<<2)>>2]=(c[(c[s>>2]|0)+(c[x>>2]<<2)>>2]|0)+1;e=c[D>>2]|0;d=c[v>>2]|0;c[v>>2]=d+1;c[(c[t>>2]|0)+(d<<2)>>2]=e}c[A>>2]=(c[A>>2]|0)+1}}if((G|0)!=(c[k>>2]|0)){F=44;break}if((c[v>>2]|0)!=(c[k>>2]|0)){F=44;break}if((c[w>>2]|0)<=(c[n>>2]|0)){F=48;break}c[o>>2]=(c[o>>2]|0)+1;if((c[o>>2]|0)!=50){continue}c[n>>2]=(c[n>>2]|0)+1;c[o>>2]=0}if((F|0)==12){Ga(1968,840,474,1976)}else if((F|0)==44){Ga(1984,840,538,1976)}else if((F|0)==48){c[q>>2]=0;c[p>>2]=0;while(1){if((c[p>>2]|0)>=(c[k>>2]|0)){break}if((a[(c[l>>2]|0)+(c[p>>2]|0)|0]|0)==71){F=c[p>>2]|0;o=c[q>>2]|0;c[q>>2]=o+1;c[(c[t>>2]|0)+(o<<2)>>2]=F}c[p>>2]=(c[p>>2]|0)+1}qf(c[t>>2]|0,c[q>>2]|0,4,c[j>>2]|0);c[p>>2]=0;while(1){if((c[p>>2]|0)>=(c[q>>2]|0)){break}a[(c[l>>2]|0)+(c[(c[t>>2]|0)+(c[p>>2]<<2)>>2]|0)|0]=(c[p>>2]|0)<((c[k>>2]|0)/5|0|0)?103:98;c[p>>2]=(c[p>>2]|0)+1}ke(c[m>>2]|0);a[(c[l>>2]|0)+(c[k>>2]|0)|0]=0;i=f;return c[l>>2]|0}return 0}function ie(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=me(12)|0;b=me(($(c[e>>2]|0,c[f>>2]|0)|0)<<3)|0;c[c[g>>2]>>2]=b;b=me(($(c[e>>2]|0,c[f>>2]|0)|0)<<3)|0;c[(c[g>>2]|0)+4>>2]=b;b=me(($(c[e>>2]|0,c[f>>2]|0)|0)<<3<<2)|0;c[(c[g>>2]|0)+8>>2]=b;i=d;return c[g>>2]|0}function je(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0;g=i;i=i+128|0;h=g+108|0;j=g+104|0;k=g+100|0;l=g+96|0;m=g+92|0;n=g+88|0;o=g+84|0;p=g+80|0;q=g+76|0;r=g+72|0;s=g+68|0;t=g+64|0;u=g+60|0;v=g+56|0;w=g+52|0;x=g+48|0;y=g+44|0;z=g+40|0;A=g+36|0;B=g+32|0;C=g+28|0;D=g+24|0;E=g+20|0;F=g+16|0;G=g+12|0;H=g+8|0;I=g+4|0;J=g+112|0;K=g;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=f;c[m>>2]=$(c[h>>2]|0,c[j>>2]|0)|0;eg(c[c[l>>2]>>2]|0,0,c[m>>2]<<3|0)|0;eg(c[(c[l>>2]|0)+4>>2]|0,0,c[m>>2]<<3|0)|0;c[p>>2]=-1;c[q>>2]=0;while(1){if((c[q>>2]|0)>=(c[j>>2]|0)){break}c[p>>2]=0;while(1){if((c[p>>2]|0)>=(c[h>>2]|0)){break}if((((c[p>>2]|0)>=0?(c[p>>2]|0)<(c[h>>2]|0):0)?(c[q>>2]|0)>=0:0)?(c[q>>2]|0)<(c[j>>2]|0):0){m=$(c[q>>2]|0,c[h>>2]|0)|0;L=a[(c[k>>2]|0)+(m+(c[p>>2]|0))|0]|0}else{L=119}if((L|0)==83){break}c[p>>2]=(c[p>>2]|0)+1}if((c[p>>2]|0)<(c[h>>2]|0)){break}c[q>>2]=(c[q>>2]|0)+1}if((c[q>>2]|0)>=(c[j>>2]|0)){Ga(2016,840,334,2024)}c[u>>2]=0;while(1){if((c[u>>2]|0)>=2){break}L=c[l>>2]|0;if((c[u>>2]|0)==0){M=c[L>>2]|0}else{M=c[L+4>>2]|0}c[w>>2]=M;c[x>>2]=(c[u>>2]|0)==0?1:-1;c[o>>2]=0;c[n>>2]=0;c[y>>2]=0;while(1){if((c[y>>2]|0)>=8){break}L=$(c[q>>2]|0,c[h>>2]|0)|0;c[z>>2]=(L+(c[p>>2]|0)<<3)+(c[y>>2]|0);L=c[z>>2]|0;m=c[o>>2]|0;c[o>>2]=m+1;c[(c[(c[l>>2]|0)+8>>2]|0)+(m<<2)>>2]=L;a[(c[w>>2]|0)+(c[z>>2]|0)|0]=1;c[y>>2]=(c[y>>2]|0)+1}a:while(1){if((c[n>>2]|0)>=(c[o>>2]|0)){break}L=c[n>>2]|0;c[n>>2]=L+1;c[A>>2]=c[(c[(c[l>>2]|0)+8>>2]|0)+(L<<2)>>2];c[B>>2]=(c[A>>2]|0)%8|0;c[C>>2]=((c[A>>2]|0)/8|0|0)%(c[h>>2]|0)|0;c[D>>2]=(c[A>>2]|0)/(c[h>>2]<<3|0)|0;c[E>>2]=-1;while(1){if((c[E>>2]|0)>=8){continue a}L=c[C>>2]|0;if((c[E>>2]|0)<0){if((c[B>>2]&3|0)!=0){N=(c[B>>2]&7|0)>4?-1:1}else{N=0}c[F>>2]=L+($(c[x>>2]|0,N)|0);if(((c[B>>2]|0)+6&3|0)!=0){O=((c[B>>2]|0)+6&7|0)>4?-1:1}else{O=0}c[G>>2]=(c[D>>2]|0)+($(c[x>>2]|0,O)|0);c[H>>2]=c[B>>2]}else{c[F>>2]=L;c[G>>2]=c[D>>2];c[H>>2]=c[E>>2]}L=$(c[G>>2]|0,c[h>>2]|0)|0;c[I>>2]=(L+(c[F>>2]|0)<<3)+(c[H>>2]|0);if(((((c[F>>2]|0)>=0?(c[F>>2]|0)<(c[h>>2]|0):0)?(c[G>>2]|0)>=0:0)?(c[G>>2]|0)<(c[j>>2]|0):0)?!(a[(c[w>>2]|0)+(c[I>>2]|0)|0]&1):0){L=c[h>>2]|0;m=c[j>>2]|0;f=c[k>>2]|0;if((c[u>>2]|0)==0){a[J]=(le(L,m,f,c[C>>2]|0,c[D>>2]|0,c[B>>2]|0,c[F>>2]|0,c[G>>2]|0,c[H>>2]|0)|0)&1}else{a[J]=(le(L,m,f,c[F>>2]|0,c[G>>2]|0,c[H>>2]|0,c[C>>2]|0,c[D>>2]|0,c[B>>2]|0)|0)&1}if(a[J]&1){f=c[I>>2]|0;m=c[o>>2]|0;c[o>>2]=m+1;c[(c[(c[l>>2]|0)+8>>2]|0)+(m<<2)>>2]=f;a[(c[w>>2]|0)+(c[I>>2]|0)|0]=1}}c[E>>2]=(c[E>>2]|0)+1}}c[u>>2]=(c[u>>2]|0)+1}c[v>>2]=0;c[s>>2]=0;while(1){if((c[s>>2]|0)>=(c[j>>2]|0)){break}c[r>>2]=0;while(1){if((c[r>>2]|0)>=(c[h>>2]|0)){break}if((((c[r>>2]|0)>=0?(c[r>>2]|0)<(c[h>>2]|0):0)?(c[s>>2]|0)>=0:0)?(c[s>>2]|0)<(c[j>>2]|0):0){u=$(c[s>>2]|0,c[h>>2]|0)|0;P=a[(c[k>>2]|0)+(u+(c[r>>2]|0))|0]|0}else{P=119}b:do{if((P|0)==98){c[t>>2]=0;while(1){if((c[t>>2]|0)>=8){break b}u=$(c[s>>2]|0,c[h>>2]|0)|0;c[K>>2]=(u+(c[r>>2]|0)<<3)+(c[t>>2]|0);if(a[(c[c[l>>2]>>2]|0)+(c[K>>2]|0)|0]&1?a[(c[(c[l>>2]|0)+4>>2]|0)+(c[K>>2]|0)|0]&1:0){break}c[t>>2]=(c[t>>2]|0)+1}u=$(c[s>>2]|0,c[h>>2]|0)|0;a[(c[k>>2]|0)+(u+(c[r>>2]|0))|0]=71;c[v>>2]=(c[v>>2]|0)+1}}while(0);c[r>>2]=(c[r>>2]|0)+1}c[s>>2]=(c[s>>2]|0)+1}i=g;return c[v>>2]|0}function ke(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;ne(c[c[d>>2]>>2]|0);ne(c[(c[d>>2]|0)+4>>2]|0);ne(c[(c[d>>2]|0)+8>>2]|0);ne(c[d>>2]|0);i=b;return}function le(b,d,e,f,g,h,j,k,l){b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;j=j|0;k=k|0;l=l|0;var m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0;m=i;i=i+48|0;n=m+36|0;o=m+32|0;p=m+28|0;q=m+24|0;r=m+20|0;s=m+16|0;t=m+12|0;u=m+8|0;v=m+4|0;w=m;c[o>>2]=b;c[p>>2]=d;c[q>>2]=e;c[r>>2]=f;c[s>>2]=g;c[t>>2]=h;c[u>>2]=j;c[v>>2]=k;c[w>>2]=l;if((((c[r>>2]|0)>=0?(c[r>>2]|0)<(c[o>>2]|0):0)?(c[s>>2]|0)>=0:0)?(c[s>>2]|0)<(c[p>>2]|0):0){l=$(c[s>>2]|0,c[o>>2]|0)|0;x=a[(c[q>>2]|0)+(l+(c[r>>2]|0))|0]|0}else{x=119}if((x|0)!=119){if((((c[r>>2]|0)>=0?(c[r>>2]|0)<(c[o>>2]|0):0)?(c[s>>2]|0)>=0:0)?(c[s>>2]|0)<(c[p>>2]|0):0){x=$(c[s>>2]|0,c[o>>2]|0)|0;y=a[(c[q>>2]|0)+(x+(c[r>>2]|0))|0]|0}else{y=119}if((y|0)!=109){do{if((c[u>>2]|0)==(c[r>>2]|0)?(c[v>>2]|0)==(c[s>>2]|0):0){if((((c[r>>2]|0)>=0?(c[r>>2]|0)<(c[o>>2]|0):0)?(c[s>>2]|0)>=0:0)?(c[s>>2]|0)<(c[p>>2]|0):0){y=$(c[s>>2]|0,c[o>>2]|0)|0;z=a[(c[q>>2]|0)+(y+(c[r>>2]|0))|0]|0}else{z=119}if((z|0)!=115){if((((c[r>>2]|0)>=0?(c[r>>2]|0)<(c[o>>2]|0):0)?(c[s>>2]|0)>=0:0)?(c[s>>2]|0)<(c[p>>2]|0):0){y=$(c[s>>2]|0,c[o>>2]|0)|0;A=a[(c[q>>2]|0)+(y+(c[r>>2]|0))|0]|0}else{A=119}if((A|0)!=83){if((c[t>>2]&3|0)!=0){B=(c[t>>2]&7|0)>4?-1:1}else{B=0}if(((c[r>>2]|0)+B|0)>=0){if((c[t>>2]&3|0)!=0){C=(c[t>>2]&7|0)>4?-1:1}else{C=0}if(((c[r>>2]|0)+C|0)<(c[o>>2]|0)){if(((c[t>>2]|0)+6&3|0)!=0){D=((c[t>>2]|0)+6&7|0)>4?-1:1}else{D=0}if(((c[s>>2]|0)+D|0)>=0){if(((c[t>>2]|0)+6&3|0)!=0){E=((c[t>>2]|0)+6&7|0)>4?-1:1}else{E=0}if(((c[s>>2]|0)+E|0)<(c[p>>2]|0)){if(((c[t>>2]|0)+6&3|0)!=0){F=((c[t>>2]|0)+6&7|0)>4?-1:1}else{F=0}y=$((c[s>>2]|0)+F|0,c[o>>2]|0)|0;if((c[t>>2]&3|0)!=0){G=(c[t>>2]&7|0)>4?-1:1}else{G=0}H=a[(c[q>>2]|0)+(y+((c[r>>2]|0)+G))|0]|0}else{H=119}}else{H=119}}else{H=119}}else{H=119}if((H|0)!=119){break}}}a[n]=1;I=a[n]|0;J=I&1;i=m;return J|0}}while(0);if((c[t>>2]&3|0)!=0){K=(c[t>>2]&7|0)>4?-1:1}else{K=0}do{if((c[u>>2]|0)==((c[r>>2]|0)+K|0)){if(((c[t>>2]|0)+6&3|0)!=0){L=((c[t>>2]|0)+6&7|0)>4?-1:1}else{L=0}if((c[v>>2]|0)==((c[s>>2]|0)+L|0)?(c[t>>2]|0)==(c[w>>2]|0):0){if((((c[u>>2]|0)>=0?(c[u>>2]|0)<(c[o>>2]|0):0)?(c[v>>2]|0)>=0:0)?(c[v>>2]|0)<(c[p>>2]|0):0){H=$(c[v>>2]|0,c[o>>2]|0)|0;M=a[(c[q>>2]|0)+(H+(c[u>>2]|0))|0]|0}else{M=119}if((M|0)!=98){if((((c[u>>2]|0)>=0?(c[u>>2]|0)<(c[o>>2]|0):0)?(c[v>>2]|0)>=0:0)?(c[v>>2]|0)<(c[p>>2]|0):0){H=$(c[v>>2]|0,c[o>>2]|0)|0;N=a[(c[q>>2]|0)+(H+(c[u>>2]|0))|0]|0}else{N=119}if((N|0)!=103){if((((c[u>>2]|0)>=0?(c[u>>2]|0)<(c[o>>2]|0):0)?(c[v>>2]|0)>=0:0)?(c[v>>2]|0)<(c[p>>2]|0):0){H=$(c[v>>2]|0,c[o>>2]|0)|0;O=a[(c[q>>2]|0)+(H+(c[u>>2]|0))|0]|0}else{O=119}if((O|0)!=115){if((((c[u>>2]|0)>=0?(c[u>>2]|0)<(c[o>>2]|0):0)?(c[v>>2]|0)>=0:0)?(c[v>>2]|0)<(c[p>>2]|0):0){H=$(c[v>>2]|0,c[o>>2]|0)|0;P=a[(c[q>>2]|0)+(H+(c[u>>2]|0))|0]|0}else{P=119}if((P|0)!=83){break}}}}a[n]=1;I=a[n]|0;J=I&1;i=m;return J|0}}}while(0);a[n]=0;I=a[n]|0;J=I&1;i=m;return J|0}}a[n]=0;I=a[n]|0;J=I&1;i=m;return J|0}function me(a){a=a|0;var b=0,d=0,e=0,f=0;b=i;i=i+16|0;d=b+8|0;e=b+4|0;c[d>>2]=a;c[e>>2]=If(c[d>>2]|0)|0;if((c[e>>2]|0)!=0){f=c[e>>2]|0;i=b;return f|0}Ac(2184,b);f=c[e>>2]|0;i=b;return f|0}function ne(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[d>>2]|0)==0){i=b;return}Jf(c[d>>2]|0);i=b;return}function oe(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0;d=i;i=i+16|0;e=d+12|0;f=d+8|0;g=d+4|0;c[e>>2]=a;c[f>>2]=b;if((c[e>>2]|0)!=0){c[g>>2]=Kf(c[e>>2]|0,c[f>>2]|0)|0}else{c[g>>2]=If(c[f>>2]|0)|0}if((c[g>>2]|0)!=0){h=c[g>>2]|0;i=d;return h|0}Ac(2184,d);h=c[g>>2]|0;i=d;return h|0}function pe(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;c[e>>2]=me(1+(dg(c[d>>2]|0)|0)|0)|0;hg(c[e>>2]|0,c[d>>2]|0)|0;i=b;return c[e>>2]|0}function qe(b){b=b|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;e=i;i=i+112|0;f=e;g=e+20|0;h=e+24|0;j=e+16|0;k=e+12|0;l=e+8|0;m=e+4|0;c[g>>2]=b;c[(c[g>>2]|0)+148>>2]=c[(c[(c[g>>2]|0)+8>>2]|0)+128>>2];c[f>>2]=c[c[(c[g>>2]|0)+8>>2]>>2];fb(h|0,2200,f|0)|0;c[l>>2]=0;c[k>>2]=0;while(1){if((a[h+(c[k>>2]|0)|0]|0)==0){break}if((bb(d[h+(c[k>>2]|0)|0]|0)|0)==0){b=(ib(d[h+(c[k>>2]|0)|0]|0)|0)&255;n=c[l>>2]|0;c[l>>2]=n+1;a[h+n|0]=b}c[k>>2]=(c[k>>2]|0)+1}a[h+(c[l>>2]|0)|0]=0;l=eb(h|0)|0;c[j>>2]=l;if((l|0)==0){i=e;return}l=c[j>>2]|0;c[f>>2]=m;j=(Na(l|0,2216,f|0)|0)==1;if(!(j&(c[m>>2]|0)>0)){i=e;return}c[(c[g>>2]|0)+148>>2]=c[m>>2];i=e;return}function re(b,e,f,h){b=b|0;e=e|0;f=f|0;h=h|0;var j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0;j=i;i=i+128|0;k=j;l=j+40|0;m=j+36|0;n=j+32|0;o=j+28|0;p=j+24|0;q=j+20|0;r=j+16|0;s=j+48|0;t=j+12|0;u=j+8|0;v=j+4|0;c[l>>2]=b;c[m>>2]=e;c[n>>2]=f;c[o>>2]=h;c[p>>2]=me(172)|0;zc(q,r);c[c[p>>2]>>2]=c[l>>2];c[(c[p>>2]|0)+8>>2]=c[m>>2];l=zf(c[q>>2]|0,c[r>>2]|0)|0;c[(c[p>>2]|0)+4>>2]=l;c[(c[p>>2]|0)+52>>2]=0;c[(c[p>>2]|0)+48>>2]=0;c[(c[p>>2]|0)+44>>2]=0;c[(c[p>>2]|0)+56>>2]=0;c[(c[p>>2]|0)+60>>2]=0;c[(c[p>>2]|0)+64>>2]=0;c[(c[p>>2]|0)+68>>2]=0;c[(c[p>>2]|0)+72>>2]=0;c[(c[p>>2]|0)+76>>2]=0;c[(c[p>>2]|0)+80>>2]=0;a[(c[p>>2]|0)+84|0]=0;l=Ib[c[(c[m>>2]|0)+12>>2]&1]()|0;c[(c[p>>2]|0)+88>>2]=l;c[(c[p>>2]|0)+164>>2]=0;c[(c[p>>2]|0)+168>>2]=0;c[(c[p>>2]|0)+16>>2]=0;c[(c[p>>2]|0)+20>>2]=0;c[k>>2]=c[c[(c[p>>2]|0)+8>>2]>>2];fb(s|0,2224,k|0)|0;c[v>>2]=0;c[u>>2]=0;while(1){if((a[s+(c[u>>2]|0)|0]|0)==0){break}if((bb(d[s+(c[u>>2]|0)|0]|0)|0)==0){k=(ib(d[s+(c[u>>2]|0)|0]|0)|0)&255;l=c[v>>2]|0;c[v>>2]=l+1;a[s+l|0]=k}c[u>>2]=(c[u>>2]|0)+1}a[s+(c[v>>2]|0)|0]=0;v=eb(s|0)|0;c[t>>2]=v;if((v|0)!=0){Kb[c[(c[(c[p>>2]|0)+8>>2]|0)+24>>2]&7](c[(c[p>>2]|0)+88>>2]|0,c[t>>2]|0)}c[(c[p>>2]|0)+92>>2]=0;c[(c[p>>2]|0)+28>>2]=0;c[(c[p>>2]|0)+24>>2]=0;c[(c[p>>2]|0)+32>>2]=0;c[(c[p>>2]|0)+36>>2]=0;c[(c[p>>2]|0)+40>>2]=2;c[(c[p>>2]|0)+96>>2]=0;c[(c[p>>2]|0)+104>>2]=0;c[(c[p>>2]|0)+12>>2]=0;g[(c[p>>2]|0)+112>>2]=0.0;g[(c[p>>2]|0)+108>>2]=0.0;g[(c[p>>2]|0)+120>>2]=0.0;g[(c[p>>2]|0)+116>>2]=0.0;c[(c[p>>2]|0)+124>>2]=0;c[(c[p>>2]|0)+100>>2]=0;c[(c[p>>2]|0)+144>>2]=0;c[(c[p>>2]|0)+136>>2]=0;a[(c[p>>2]|0)+128|0]=0;g[(c[p>>2]|0)+132>>2]=0.0;c[(c[p>>2]|0)+160>>2]=0;c[(c[p>>2]|0)+156>>2]=0;c[(c[p>>2]|0)+152>>2]=0;if((c[n>>2]|0)!=0){t=kc(c[n>>2]|0,c[p>>2]|0,c[o>>2]|0)|0;c[(c[p>>2]|0)+140>>2]=t;w=c[p>>2]|0;qe(w);x=c[q>>2]|0;ne(x);y=c[p>>2]|0;i=j;return y|0}else{c[(c[p>>2]|0)+140>>2]=0;w=c[p>>2]|0;qe(w);x=c[q>>2]|0;ne(x);y=c[p>>2]|0;i=j;return y|0}return 0}function se(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b;c[d>>2]=a;while(1){e=c[d>>2]|0;if((c[(c[d>>2]|0)+44>>2]|0)<=0){break}a=e+44|0;c[a>>2]=(c[a>>2]|0)+ -1;Jb[c[(c[(c[d>>2]|0)+8>>2]|0)+72>>2]&7](c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)>>2]|0);ne(c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)+4>>2]|0)}if((c[e+96>>2]|0)==0){i=b;return}Kb[c[(c[(c[d>>2]|0)+8>>2]|0)+148>>2]&7](c[(c[d>>2]|0)+140>>2]|0,c[(c[d>>2]|0)+96>>2]|0);i=b;return}function te(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0;g=i;i=i+48|0;h=g+28|0;j=g+24|0;k=g+20|0;l=g+32|0;m=g+16|0;n=g+12|0;o=g+8|0;p=g+4|0;q=g;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;a[l]=f&1;if((c[(c[h>>2]|0)+96>>2]|0)!=0?(c[(c[h>>2]|0)+152>>2]|0)>0:0){Kb[c[(c[(c[h>>2]|0)+8>>2]|0)+148>>2]&7](c[(c[h>>2]|0)+140>>2]|0,c[(c[h>>2]|0)+96>>2]|0);f=Tb[c[(c[(c[h>>2]|0)+8>>2]|0)+144>>2]&15](c[(c[h>>2]|0)+140>>2]|0,c[c[(c[h>>2]|0)+56>>2]>>2]|0)|0;c[(c[h>>2]|0)+96>>2]=f}a:do{if(a[l]&1){c[n>>2]=1;do{c[n>>2]=c[n>>2]<<1;Vb[c[(c[(c[h>>2]|0)+8>>2]|0)+132>>2]&7](c[(c[h>>2]|0)+88>>2]|0,c[n>>2]|0,o,p);if((c[o>>2]|0)>(c[c[j>>2]>>2]|0)){break a}}while((c[p>>2]|0)<=(c[c[k>>2]>>2]|0))}else{c[n>>2]=(c[(c[h>>2]|0)+148>>2]|0)+1}}while(0);c[m>>2]=1;while(1){if(((c[n>>2]|0)-(c[m>>2]|0)|0)<=1){break}c[q>>2]=((c[n>>2]|0)+(c[m>>2]|0)|0)/2|0;Vb[c[(c[(c[h>>2]|0)+8>>2]|0)+132>>2]&7](c[(c[h>>2]|0)+88>>2]|0,c[q>>2]|0,o,p);if((c[o>>2]|0)<=(c[c[j>>2]>>2]|0)?(c[p>>2]|0)<=(c[c[k>>2]>>2]|0):0){c[m>>2]=c[q>>2];continue}c[n>>2]=c[q>>2]}c[(c[h>>2]|0)+152>>2]=c[m>>2];if(!(a[l]&1)){r=c[h>>2]|0;ue(r);s=c[h>>2]|0;t=s+156|0;u=c[t>>2]|0;v=c[j>>2]|0;c[v>>2]=u;w=c[h>>2]|0;x=w+160|0;y=c[x>>2]|0;z=c[k>>2]|0;c[z>>2]=y;i=g;return}c[(c[h>>2]|0)+148>>2]=c[(c[h>>2]|0)+152>>2];r=c[h>>2]|0;ue(r);s=c[h>>2]|0;t=s+156|0;u=c[t>>2]|0;v=c[j>>2]|0;c[v>>2]=u;w=c[h>>2]|0;x=w+160|0;y=c[x>>2]|0;z=c[k>>2]|0;c[z>>2]=y;i=g;return}function ue(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+152>>2]|0)<=0){i=b;return}Vb[c[(c[(c[d>>2]|0)+8>>2]|0)+132>>2]&7](c[(c[d>>2]|0)+88>>2]|0,c[(c[d>>2]|0)+152>>2]|0,(c[d>>2]|0)+156|0,(c[d>>2]|0)+160|0);Vb[c[(c[(c[d>>2]|0)+8>>2]|0)+136>>2]&7](c[(c[d>>2]|0)+140>>2]|0,c[(c[d>>2]|0)+96>>2]|0,c[(c[d>>2]|0)+88>>2]|0,c[(c[d>>2]|0)+152>>2]|0);i=b;return}function ve(a,b){a=a|0;b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;c[e>>2]=a;c[f>>2]=b;Jb[c[(c[(c[e>>2]|0)+8>>2]|0)+32>>2]&7](c[(c[e>>2]|0)+88>>2]|0);b=Ob[c[(c[(c[e>>2]|0)+8>>2]|0)+36>>2]&15](c[f>>2]|0)|0;c[(c[e>>2]|0)+88>>2]=b;i=d;return}function we(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+96>>2]|0)!=0){Kb[c[(c[(c[d>>2]|0)+8>>2]|0)+148>>2]&7](c[(c[d>>2]|0)+140>>2]|0,c[(c[d>>2]|0)+96>>2]|0)}a=Tb[c[(c[(c[d>>2]|0)+8>>2]|0)+144>>2]&15](c[(c[d>>2]|0)+140>>2]|0,c[c[(c[d>>2]|0)+56>>2]>>2]|0)|0;c[(c[d>>2]|0)+96>>2]=a;ue(c[d>>2]|0);xe(c[d>>2]|0);i=b;return}function xe(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+140>>2]|0)==0){Ga(2368,2264,1140,2384)}if((c[(c[d>>2]|0)+52>>2]|0)<=0){i=b;return}if((c[(c[d>>2]|0)+96>>2]|0)==0){i=b;return}sc(c[(c[d>>2]|0)+140>>2]|0);do{if(((c[(c[d>>2]|0)+104>>2]|0)!=0?+g[(c[d>>2]|0)+108>>2]>0.0:0)?+g[(c[d>>2]|0)+112>>2]<+g[(c[d>>2]|0)+108>>2]:0){if((c[(c[d>>2]|0)+124>>2]|0)!=0){Nb[c[(c[(c[d>>2]|0)+8>>2]|0)+152>>2]&1](c[(c[d>>2]|0)+140>>2]|0,c[(c[d>>2]|0)+96>>2]|0,c[(c[d>>2]|0)+104>>2]|0,c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[d>>2]|0)+124>>2]|0,c[(c[d>>2]|0)+100>>2]|0,+g[(c[d>>2]|0)+112>>2],+g[(c[d>>2]|0)+120>>2]);break}else{Ga(2400,2264,1146,2384)}}else{e=11}}while(0);if((e|0)==11){Nb[c[(c[(c[d>>2]|0)+8>>2]|0)+152>>2]&1](c[(c[d>>2]|0)+140>>2]|0,c[(c[d>>2]|0)+96>>2]|0,0,c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,1,c[(c[d>>2]|0)+100>>2]|0,0.0,+g[(c[d>>2]|0)+120>>2])}tc(c[(c[d>>2]|0)+140>>2]|0);i=b;return}function ye(b){b=b|0;var d=0,e=0,f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0;d=i;i=i+48|0;e=d+20|0;f=d+16|0;h=d+24|0;j=d+12|0;k=d+8|0;l=d+4|0;m=d;c[e>>2]=b;c[(c[e>>2]|0)+64>>2]=0;if(a[(c[e>>2]|0)+84|0]&1){ze(c[e>>2]|0);Ae(c[e>>2]|0,5,(c[e>>2]|0)+60|0)}Ce(c[e>>2]|0);se(c[e>>2]|0);if((c[(c[e>>2]|0)+44>>2]|0)!=0){Ga(2240,2264,444,2280)}b=(c[e>>2]|0)+40|0;if((c[(c[e>>2]|0)+40>>2]|0)==1){c[b>>2]=2}else{if((c[b>>2]|0)==0){c[(c[e>>2]|0)+40>>2]=2}else{a[h+15|0]=0;a[h]=49+(((Bf(c[(c[e>>2]|0)+4>>2]|0,9)|0)&255)<<24>>24);c[j>>2]=1;while(1){n=c[e>>2]|0;if((c[j>>2]|0)>=15){break}b=48+(((Bf(c[n+4>>2]|0,10)|0)&255)<<24>>24)&255;a[h+(c[j>>2]|0)|0]=b;c[j>>2]=(c[j>>2]|0)+1}ne(c[n+32>>2]|0);n=pe(h)|0;c[(c[e>>2]|0)+32>>2]=n;if((c[(c[e>>2]|0)+92>>2]|0)!=0){Jb[c[(c[(c[e>>2]|0)+8>>2]|0)+32>>2]&7](c[(c[e>>2]|0)+92>>2]|0)}n=Ob[c[(c[(c[e>>2]|0)+8>>2]|0)+36>>2]&15](c[(c[e>>2]|0)+88>>2]|0)|0;c[(c[e>>2]|0)+92>>2]=n}ne(c[(c[e>>2]|0)+24>>2]|0);ne(c[(c[e>>2]|0)+28>>2]|0);ne(c[(c[e>>2]|0)+36>>2]|0);c[(c[e>>2]|0)+36>>2]=0;n=c[(c[e>>2]|0)+32>>2]|0;c[f>>2]=zf(n,dg(c[(c[e>>2]|0)+32>>2]|0)|0)|0;n=Gb[c[(c[(c[e>>2]|0)+8>>2]|0)+56>>2]&3](c[(c[e>>2]|0)+92>>2]|0,c[f>>2]|0,(c[e>>2]|0)+36|0,(c[(c[e>>2]|0)+140>>2]|0)!=0)|0;c[(c[e>>2]|0)+24>>2]=n;c[(c[e>>2]|0)+28>>2]=0;Cf(c[f>>2]|0)}if((c[(c[e>>2]|0)+44>>2]|0)>=(c[(c[e>>2]|0)+48>>2]|0)){c[(c[e>>2]|0)+48>>2]=(c[(c[e>>2]|0)+44>>2]|0)+128;f=oe(c[(c[e>>2]|0)+56>>2]|0,(c[(c[e>>2]|0)+48>>2]|0)*12|0)|0;c[(c[e>>2]|0)+56>>2]=f}f=Pb[c[(c[(c[e>>2]|0)+8>>2]|0)+64>>2]&7](c[e>>2]|0,c[(c[e>>2]|0)+88>>2]|0,c[(c[e>>2]|0)+24>>2]|0)|0;c[(c[(c[e>>2]|0)+56>>2]|0)+((c[(c[e>>2]|0)+44>>2]|0)*12|0)>>2]=f;do{if(a[(c[(c[e>>2]|0)+8>>2]|0)+76|0]&1?(c[(c[e>>2]|0)+36>>2]|0)!=0:0){c[l>>2]=0;c[m>>2]=Gb[c[(c[(c[e>>2]|0)+8>>2]|0)+80>>2]&3](c[c[(c[e>>2]|0)+56>>2]>>2]|0,c[c[(c[e>>2]|0)+56>>2]>>2]|0,c[(c[e>>2]|0)+36>>2]|0,l)|0;if((c[m>>2]|0)==0){Ga(2296,2264,526,2280)}if((c[l>>2]|0)!=0){Ga(2296,2264,526,2280)}c[k>>2]=Tb[c[(c[(c[e>>2]|0)+8>>2]|0)+124>>2]&15](c[c[(c[e>>2]|0)+56>>2]>>2]|0,c[m>>2]|0)|0;if((c[k>>2]|0)!=0){Jb[c[(c[(c[e>>2]|0)+8>>2]|0)+72>>2]&7](c[k>>2]|0);ne(c[m>>2]|0);break}else{Ga(2312,2264,528,2280)}}}while(0);c[(c[(c[e>>2]|0)+56>>2]|0)+((c[(c[e>>2]|0)+44>>2]|0)*12|0)+4>>2]=0;c[(c[(c[e>>2]|0)+56>>2]|0)+((c[(c[e>>2]|0)+44>>2]|0)*12|0)+8>>2]=0;m=(c[e>>2]|0)+44|0;c[m>>2]=(c[m>>2]|0)+1;c[(c[e>>2]|0)+52>>2]=1;m=Tb[c[(c[(c[e>>2]|0)+8>>2]|0)+144>>2]&15](c[(c[e>>2]|0)+140>>2]|0,c[c[(c[e>>2]|0)+56>>2]>>2]|0)|0;c[(c[e>>2]|0)+96>>2]=m;ue(c[e>>2]|0);g[(c[e>>2]|0)+132>>2]=0.0;g[(c[e>>2]|0)+116>>2]=0.0;g[(c[e>>2]|0)+120>>2]=0.0;g[(c[e>>2]|0)+108>>2]=0.0;g[(c[e>>2]|0)+112>>2]=0.0;if((c[(c[e>>2]|0)+100>>2]|0)!=0){Jb[c[(c[(c[e>>2]|0)+8>>2]|0)+100>>2]&7](c[(c[e>>2]|0)+100>>2]|0)}m=Ob[c[(c[(c[e>>2]|0)+8>>2]|0)+96>>2]&15](c[c[(c[e>>2]|0)+56>>2]>>2]|0)|0;c[(c[e>>2]|0)+100>>2]=m;De(c[e>>2]|0);c[(c[e>>2]|0)+144>>2]=0;if((c[(c[e>>2]|0)+164>>2]|0)==0){o=c[e>>2]|0;p=o+84|0;a[p]=1;i=d;return}Jb[c[(c[e>>2]|0)+164>>2]&7](c[(c[e>>2]|0)+168>>2]|0);o=c[e>>2]|0;p=o+84|0;a[p]=1;i=d;return}function ze(a){a=a|0;var b=0,d=0,e=0,f=0,g=0;b=i;i=i+16|0;d=b;c[d>>2]=a;while(1){e=c[d>>2]|0;if((c[(c[d>>2]|0)+44>>2]|0)<=(c[(c[d>>2]|0)+52>>2]|0)){break}a=c[(c[e+8>>2]|0)+72>>2]|0;f=(c[d>>2]|0)+44|0;g=(c[f>>2]|0)+ -1|0;c[f>>2]=g;Jb[a&7](c[(c[(c[d>>2]|0)+56>>2]|0)+(g*12|0)>>2]|0);if((c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)+4>>2]|0)==0){continue}ne(c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)+4>>2]|0)}c[e+76>>2]=0;i=b;return}function Ae(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,j=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,$=0,aa=0,ba=0,ca=0,da=0,ea=0,fa=0,ga=0,ha=0,ia=0,ja=0,ka=0,la=0,ma=0,na=0,oa=0,pa=0,qa=0,ra=0,sa=0;f=i;i=i+1808|0;j=f;l=f+112|0;m=f+108|0;n=f+104|0;o=f+100|0;p=f+1728|0;q=f+96|0;r=f+1712|0;s=f+1632|0;t=f+92|0;u=f+1616|0;v=f+88|0;w=f+1536|0;x=f+84|0;y=f+1520|0;z=f+80|0;A=f+1440|0;B=f+76|0;C=f+1424|0;D=f+72|0;E=f+1344|0;F=f+68|0;G=f+1328|0;H=f+1248|0;I=f+64|0;J=f+1232|0;K=f+1152|0;L=f+60|0;M=f+1136|0;N=f+1056|0;O=f+56|0;P=f+1040|0;Q=f+52|0;R=f+48|0;S=f+44|0;T=f+960|0;U=f+40|0;V=f+944|0;W=f+36|0;X=f+864|0;Y=f+32|0;Z=f+848|0;_=f+768|0;$=f+688|0;aa=f+28|0;ba=f+672|0;ca=f+592|0;da=f+512|0;ea=f+24|0;fa=f+496|0;ga=f+416|0;ha=f+20|0;ia=f+400|0;ja=f+320|0;ka=f+16|0;la=f+304|0;ma=f+224|0;na=f+12|0;oa=f+208|0;pa=f+128|0;qa=f+8|0;ra=f+116|0;c[l>>2]=b;c[m>>2]=d;c[n>>2]=e;c[q>>2]=2928;sf(r,9,2976);e=dg(c[q>>2]|0)|0;c[j>>2]=r;c[j+4>>2]=e;fb(p|0,2992,j|0)|0;e=c[m>>2]|0;r=c[n>>2]|0;d=dg(p|0)|0;Qb[e&7](r,p,d);d=c[m>>2]|0;p=c[n>>2]|0;r=c[q>>2]|0;e=dg(c[q>>2]|0)|0;Qb[d&7](p,r,e);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);c[t>>2]=3008;sf(u,9,3016);e=dg(c[t>>2]|0)|0;c[j>>2]=u;c[j+4>>2]=e;fb(s|0,2992,j|0)|0;e=c[m>>2]|0;u=c[n>>2]|0;r=dg(s|0)|0;Qb[e&7](u,s,r);r=c[m>>2]|0;s=c[n>>2]|0;u=c[t>>2]|0;e=dg(c[t>>2]|0)|0;Qb[r&7](s,u,e);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);c[v>>2]=pe(c[c[(c[l>>2]|0)+8>>2]>>2]|0)|0;c[x>>2]=c[v>>2];sf(y,9,3024);e=dg(c[x>>2]|0)|0;c[j>>2]=y;c[j+4>>2]=e;fb(w|0,2992,j|0)|0;e=c[m>>2]|0;y=c[n>>2]|0;u=dg(w|0)|0;Qb[e&7](y,w,u);u=c[m>>2]|0;w=c[n>>2]|0;y=c[x>>2]|0;e=dg(c[x>>2]|0)|0;Qb[u&7](w,y,e);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);ne(c[v>>2]|0);if((c[(c[l>>2]|0)+88>>2]|0)!=0){c[z>>2]=Tb[c[(c[(c[l>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[l>>2]|0)+88>>2]|0,1)|0;c[B>>2]=c[z>>2];sf(C,9,3032);v=dg(c[B>>2]|0)|0;c[j>>2]=C;c[j+4>>2]=v;fb(A|0,2992,j|0)|0;v=c[m>>2]|0;C=c[n>>2]|0;e=dg(A|0)|0;Qb[v&7](C,A,e);e=c[m>>2]|0;A=c[n>>2]|0;C=c[B>>2]|0;v=dg(c[B>>2]|0)|0;Qb[e&7](A,C,v);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);ne(c[z>>2]|0)}if((c[(c[l>>2]|0)+92>>2]|0)!=0){c[D>>2]=Tb[c[(c[(c[l>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[l>>2]|0)+92>>2]|0,1)|0;c[F>>2]=c[D>>2];sf(G,9,3040);z=dg(c[F>>2]|0)|0;c[j>>2]=G;c[j+4>>2]=z;fb(E|0,2992,j|0)|0;z=c[m>>2]|0;G=c[n>>2]|0;v=dg(E|0)|0;Qb[z&7](G,E,v);v=c[m>>2]|0;E=c[n>>2]|0;G=c[F>>2]|0;z=dg(c[F>>2]|0)|0;Qb[v&7](E,G,z);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);ne(c[D>>2]|0)}if((c[(c[l>>2]|0)+32>>2]|0)!=0){c[I>>2]=c[(c[l>>2]|0)+32>>2];sf(J,9,3048);D=dg(c[I>>2]|0)|0;c[j>>2]=J;c[j+4>>2]=D;fb(H|0,2992,j|0)|0;D=c[m>>2]|0;J=c[n>>2]|0;z=dg(H|0)|0;Qb[D&7](J,H,z);z=c[m>>2]|0;H=c[n>>2]|0;J=c[I>>2]|0;D=dg(c[I>>2]|0)|0;Qb[z&7](H,J,D);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}if((c[(c[l>>2]|0)+24>>2]|0)!=0){c[L>>2]=c[(c[l>>2]|0)+24>>2];sf(M,9,3056);D=dg(c[L>>2]|0)|0;c[j>>2]=M;c[j+4>>2]=D;fb(K|0,2992,j|0)|0;D=c[m>>2]|0;M=c[n>>2]|0;J=dg(K|0)|0;Qb[D&7](M,K,J);J=c[m>>2]|0;K=c[n>>2]|0;M=c[L>>2]|0;D=dg(c[L>>2]|0)|0;Qb[J&7](K,M,D);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}if((c[(c[l>>2]|0)+28>>2]|0)!=0){c[O>>2]=c[(c[l>>2]|0)+28>>2];sf(P,9,3064);D=dg(c[O>>2]|0)|0;c[j>>2]=P;c[j+4>>2]=D;fb(N|0,2992,j|0)|0;D=c[m>>2]|0;P=c[n>>2]|0;M=dg(N|0)|0;Qb[D&7](P,N,M);M=c[m>>2]|0;N=c[n>>2]|0;P=c[O>>2]|0;D=dg(c[O>>2]|0)|0;Qb[M&7](N,P,D);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}if((c[(c[l>>2]|0)+36>>2]|0)!=0){c[S>>2]=dg(c[(c[l>>2]|0)+36>>2]|0)|0;c[Q>>2]=me(c[S>>2]|0)|0;bg(c[Q>>2]|0,c[(c[l>>2]|0)+36>>2]|0,c[S>>2]|0)|0;lf(c[Q>>2]|0,c[S>>2]<<3,0);c[R>>2]=mf(c[Q>>2]|0,c[S>>2]|0)|0;c[U>>2]=c[R>>2];sf(V,9,3080);S=dg(c[U>>2]|0)|0;c[j>>2]=V;c[j+4>>2]=S;fb(T|0,2992,j|0)|0;S=c[m>>2]|0;V=c[n>>2]|0;D=dg(T|0)|0;Qb[S&7](V,T,D);D=c[m>>2]|0;T=c[n>>2]|0;V=c[U>>2]|0;S=dg(c[U>>2]|0)|0;Qb[D&7](T,V,S);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);ne(c[R>>2]|0);ne(c[Q>>2]|0)}if((c[(c[l>>2]|0)+100>>2]|0)!=0?(c[W>>2]=Ob[c[(c[(c[l>>2]|0)+8>>2]|0)+104>>2]&15](c[(c[l>>2]|0)+100>>2]|0)|0,(c[W>>2]|0)!=0):0){c[Y>>2]=c[W>>2];sf(Z,9,3088);Q=dg(c[Y>>2]|0)|0;c[j>>2]=Z;c[j+4>>2]=Q;fb(X|0,2992,j|0)|0;Q=c[m>>2]|0;Z=c[n>>2]|0;R=dg(X|0)|0;Qb[Q&7](Z,X,R);R=c[m>>2]|0;X=c[n>>2]|0;Z=c[Y>>2]|0;Q=dg(c[Y>>2]|0)|0;Qb[R&7](X,Z,Q);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);ne(c[W>>2]|0)}if(a[(c[(c[l>>2]|0)+8>>2]|0)+181|0]&1){h[k>>3]=+g[(c[l>>2]|0)+132>>2];c[j>>2]=c[k>>2];c[j+4>>2]=c[k+4>>2];fb(_|0,3096,j|0)|0;c[aa>>2]=_;sf(ba,9,3104);_=dg(c[aa>>2]|0)|0;c[j>>2]=ba;c[j+4>>2]=_;fb($|0,2992,j|0)|0;_=c[m>>2]|0;ba=c[n>>2]|0;W=dg($|0)|0;Qb[_&7](ba,$,W);W=c[m>>2]|0;$=c[n>>2]|0;ba=c[aa>>2]|0;_=dg(c[aa>>2]|0)|0;Qb[W&7]($,ba,_);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}c[j>>2]=c[(c[l>>2]|0)+44>>2];fb(ca|0,2216,j|0)|0;c[ea>>2]=ca;sf(fa,9,3112);_=dg(c[ea>>2]|0)|0;c[j>>2]=fa;c[j+4>>2]=_;fb(da|0,2992,j|0)|0;_=c[m>>2]|0;fa=c[n>>2]|0;ba=dg(da|0)|0;Qb[_&7](fa,da,ba);ba=c[m>>2]|0;da=c[n>>2]|0;fa=c[ea>>2]|0;_=dg(c[ea>>2]|0)|0;Qb[ba&7](da,fa,_);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);c[j>>2]=c[(c[l>>2]|0)+52>>2];fb(ca|0,2216,j|0)|0;c[ha>>2]=ca;sf(ia,9,3120);ca=dg(c[ha>>2]|0)|0;c[j>>2]=ia;c[j+4>>2]=ca;fb(ga|0,2992,j|0)|0;ca=c[m>>2]|0;ia=c[n>>2]|0;_=dg(ga|0)|0;Qb[ca&7](ia,ga,_);_=c[m>>2]|0;ga=c[n>>2]|0;ia=c[ha>>2]|0;ca=dg(c[ha>>2]|0)|0;Qb[_&7](ga,ia,ca);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1);c[o>>2]=1;while(1){if((c[o>>2]|0)>=(c[(c[l>>2]|0)+44>>2]|0)){sa=27;break}if((c[(c[(c[l>>2]|0)+56>>2]|0)+((c[o>>2]|0)*12|0)+8>>2]|0)==0){sa=21;break}ca=c[(c[(c[l>>2]|0)+56>>2]|0)+((c[o>>2]|0)*12|0)+8>>2]|0;if((ca|0)==2){c[na>>2]=c[(c[(c[l>>2]|0)+56>>2]|0)+((c[o>>2]|0)*12|0)+4>>2];sf(oa,9,3208);ia=dg(c[na>>2]|0)|0;c[j>>2]=oa;c[j+4>>2]=ia;fb(ma|0,2992,j|0)|0;ia=c[m>>2]|0;ga=c[n>>2]|0;_=dg(ma|0)|0;Qb[ia&7](ga,ma,_);_=c[m>>2]|0;ga=c[n>>2]|0;ia=c[na>>2]|0;ha=dg(c[na>>2]|0)|0;Qb[_&7](ga,ia,ha);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}else if((ca|0)==1){c[ka>>2]=c[(c[(c[l>>2]|0)+56>>2]|0)+((c[o>>2]|0)*12|0)+4>>2];sf(la,9,3200);ha=dg(c[ka>>2]|0)|0;c[j>>2]=la;c[j+4>>2]=ha;fb(ja|0,2992,j|0)|0;ha=c[m>>2]|0;ia=c[n>>2]|0;ga=dg(ja|0)|0;Qb[ha&7](ia,ja,ga);ga=c[m>>2]|0;ia=c[n>>2]|0;ha=c[ka>>2]|0;_=dg(c[ka>>2]|0)|0;Qb[ga&7](ia,ha,_);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}else if((ca|0)==3){c[qa>>2]=c[(c[(c[l>>2]|0)+56>>2]|0)+((c[o>>2]|0)*12|0)+4>>2];sf(ra,9,3216);ca=dg(c[qa>>2]|0)|0;c[j>>2]=ra;c[j+4>>2]=ca;fb(pa|0,2992,j|0)|0;ca=c[m>>2]|0;_=c[n>>2]|0;ha=dg(pa|0)|0;Qb[ca&7](_,pa,ha);ha=c[m>>2]|0;_=c[n>>2]|0;ca=c[qa>>2]|0;ia=dg(c[qa>>2]|0)|0;Qb[ha&7](_,ca,ia);Qb[c[m>>2]&7](c[n>>2]|0,3e3,1)}c[o>>2]=(c[o>>2]|0)+1}if((sa|0)==21){Ga(3136,2264,2045,3176)}else if((sa|0)==27){i=f;return}}function Be(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0;e=i;i=i+32|0;f=e+16|0;g=e+12|0;h=e+8|0;j=e+4|0;k=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;c[j>>2]=c[f>>2];if((c[h>>2]|0)>=(2147483647-(c[(c[j>>2]|0)+4>>2]|0)|0)){Ga(4216,2264,409,4248)}c[k>>2]=(c[(c[j>>2]|0)+4>>2]|0)+(c[h>>2]|0);if((c[k>>2]|0)>(c[(c[j>>2]|0)+8>>2]|0)){c[(c[j>>2]|0)+8>>2]=(c[k>>2]|0)+((c[k>>2]|0)/4|0)+1024;f=oe(c[c[j>>2]>>2]|0,c[(c[j>>2]|0)+8>>2]|0)|0;c[c[j>>2]>>2]=f}bg((c[c[j>>2]>>2]|0)+(c[(c[j>>2]|0)+4>>2]|0)|0,c[g>>2]|0,c[h>>2]|0)|0;c[(c[j>>2]|0)+4>>2]=c[k>>2];i=e;return}function Ce(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+104>>2]|0)==0?!(+g[(c[d>>2]|0)+108>>2]!=0.0):0){i=b;return}Ge(c[d>>2]|0);xe(c[d>>2]|0);i=b;return}function De(b){b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d;c[e>>2]=b;if(a[(c[(c[e>>2]|0)+8>>2]|0)+181|0]&1){f=Tb[c[(c[(c[e>>2]|0)+8>>2]|0)+184>>2]&15](c[(c[(c[e>>2]|0)+56>>2]|0)+(((c[(c[e>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[e>>2]|0)+100>>2]|0)|0}else{f=0}a[(c[e>>2]|0)+128|0]=f&1;if((!(a[(c[e>>2]|0)+128|0]&1)?!(+g[(c[e>>2]|0)+116>>2]!=0.0):0)?!(+g[(c[e>>2]|0)+108>>2]!=0.0):0){Cc(c[c[e>>2]>>2]|0);i=d;return}Dc(c[c[e>>2]>>2]|0);i=d;return}function Ee(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+52>>2]|0)>1){e=1;i=b;return e|0}e=(c[(c[d>>2]|0)+64>>2]|0)!=0;i=b;return e|0}function Fe(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b;c[d>>2]=a;if((c[(c[d>>2]|0)+52>>2]|0)<(c[(c[d>>2]|0)+44>>2]|0)){e=1;i=b;return e|0}e=(c[(c[d>>2]|0)+76>>2]|0)!=0;i=b;return e|0}function Ge(a){a=a|0;var b=0,d=0,e=0,f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;if(!((c[(c[d>>2]|0)+104>>2]|0)==0?(c[(c[d>>2]|0)+52>>2]|0)<=1:0)){f=3}do{if((f|0)==3){if(!((c[(c[d>>2]|0)+124>>2]|0)>0?(c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-1|0)*12|0)+8>>2]|0)==1:0)){if((c[(c[d>>2]|0)+124>>2]|0)>=0){break}if((c[(c[d>>2]|0)+52>>2]|0)>=(c[(c[d>>2]|0)+44>>2]|0)){break}if((c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+52>>2]|0)*12|0)+8>>2]|0)!=1){break}}a=c[d>>2]|0;if((c[(c[d>>2]|0)+104>>2]|0)!=0){h=c[a+104>>2]|0}else{h=c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[a+52>>2]|0)-2|0)*12|0)>>2]|0}if((c[(c[d>>2]|0)+104>>2]|0)!=0){j=c[(c[d>>2]|0)+124>>2]|0}else{j=1}g[e>>2]=+Ub[c[(c[(c[d>>2]|0)+8>>2]|0)+160>>2]&3](h,c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,j,c[(c[d>>2]|0)+100>>2]|0);if(+g[e>>2]>0.0){g[(c[d>>2]|0)+120>>2]=0.0;g[(c[d>>2]|0)+116>>2]=+g[e>>2]}}}while(0);if((c[(c[d>>2]|0)+104>>2]|0)==0){k=c[d>>2]|0;l=k+104|0;c[l>>2]=0;m=c[d>>2]|0;n=m+108|0;g[n>>2]=0.0;o=c[d>>2]|0;p=o+112|0;g[p>>2]=0.0;q=c[d>>2]|0;r=q+124|0;c[r>>2]=0;s=c[d>>2]|0;De(s);i=b;return}Jb[c[(c[(c[d>>2]|0)+8>>2]|0)+72>>2]&7](c[(c[d>>2]|0)+104>>2]|0);k=c[d>>2]|0;l=k+104|0;c[l>>2]=0;m=c[d>>2]|0;n=m+108|0;g[n>>2]=0.0;o=c[d>>2]|0;p=o+112|0;g[p>>2]=0.0;q=c[d>>2]|0;r=q+124|0;c[r>>2]=0;s=c[d>>2]|0;De(s);i=b;return}function He(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;if((c[(c[d>>2]|0)+52>>2]|0)<1){Ga(2320,2264,829,2344)}if((c[(c[d>>2]|0)+52>>2]|0)==1){i=b;return}c[e>>2]=Pb[c[(c[(c[d>>2]|0)+8>>2]|0)+64>>2]&7](c[d>>2]|0,c[(c[d>>2]|0)+88>>2]|0,c[(c[d>>2]|0)+24>>2]|0)|0;Ce(c[d>>2]|0);ze(c[d>>2]|0);if((c[(c[d>>2]|0)+44>>2]|0)>=(c[(c[d>>2]|0)+48>>2]|0)){c[(c[d>>2]|0)+48>>2]=(c[(c[d>>2]|0)+44>>2]|0)+128;a=oe(c[(c[d>>2]|0)+56>>2]|0,(c[(c[d>>2]|0)+48>>2]|0)*12|0)|0;c[(c[d>>2]|0)+56>>2]=a}c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)>>2]=c[e>>2];e=pe(c[(c[d>>2]|0)+24>>2]|0)|0;c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)+4>>2]=e;c[(c[(c[d>>2]|0)+56>>2]|0)+((c[(c[d>>2]|0)+44>>2]|0)*12|0)+8>>2]=3;e=(c[d>>2]|0)+44|0;a=(c[e>>2]|0)+1|0;c[e>>2]=a;c[(c[d>>2]|0)+52>>2]=a;if((c[(c[d>>2]|0)+100>>2]|0)!=0){Qb[c[(c[(c[d>>2]|0)+8>>2]|0)+116>>2]&7](c[(c[d>>2]|0)+100>>2]|0,c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0,c[(c[(c[d>>2]|0)+56>>2]|0)+(((c[(c[d>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0)}g[(c[d>>2]|0)+116>>2]=0.0;g[(c[d>>2]|0)+120>>2]=0.0;Ge(c[d>>2]|0);xe(c[d>>2]|0);De(c[d>>2]|0);i=b;return}function Ie(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0;g=i;i=i+32|0;h=g+17|0;j=g+12|0;k=g+8|0;l=g+4|0;m=g;n=g+16|0;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;a[n]=1;if(!(((c[m>>2]|0)-515|0)>>>0<=2)?!(((c[m>>2]|0)-518|0)>>>0<=2):0){if(((c[m>>2]|0)-512|0)>>>0<=2?(c[(c[j>>2]|0)+144>>2]|0)!=0:0){f=a[n]&1;if((c[(c[(c[j>>2]|0)+8>>2]|0)+188>>2]&1<<(((c[(c[j>>2]|0)+144>>2]|0)-512|0)*3|0)+(c[m>>2]|0)-512|0)!=0){a[h]=f&1;o=a[h]|0;p=o&1;i=g;return p|0}if(f){q=Je(c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,(c[(c[j>>2]|0)+144>>2]|0)+6|0)|0}else{q=0}a[n]=q&1}}else{r=3}do{if((r|0)==3){if((c[(c[j>>2]|0)+144>>2]|0)==0){a[h]=a[n]&1;o=a[h]|0;p=o&1;i=g;return p|0}q=c[(c[j>>2]|0)+144>>2]|0;if(((c[m>>2]|0)-515|0)>>>0<=2){c[m>>2]=q+3;break}else{c[m>>2]=q+6;break}}}while(0);if((c[m>>2]|0)==10|(c[m>>2]|0)==13){c[m>>2]=525}if((c[m>>2]|0)==32){c[m>>2]=526}if((c[m>>2]|0)==127){c[m>>2]=8}if(a[n]&1){s=Je(c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0)|0}else{s=0}a[n]=s&1;if(!(((c[m>>2]|0)-518|0)>>>0<=2)){if(((c[m>>2]|0)-512|0)>>>0<=2){c[(c[j>>2]|0)+144>>2]=c[m>>2]}}else{c[(c[j>>2]|0)+144>>2]=0}a[h]=a[n]&1;o=a[h]|0;p=o&1;i=g;return p|0}function Je(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0;h=i;i=i+48|0;j=h+32|0;k=h+28|0;l=h+24|0;m=h+20|0;n=h+16|0;o=h+12|0;p=h+37|0;q=h+36|0;r=h+8|0;s=h+4|0;t=h;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;c[n>>2]=Ob[c[(c[(c[j>>2]|0)+8>>2]|0)+68>>2]&15](c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0)|0;c[o>>2]=1;a[p]=0;a[q]=1;c[t>>2]=0;if(!((c[m>>2]|0)>527&(c[m>>2]|0)<533)){c[t>>2]=Lb[c[(c[(c[j>>2]|0)+8>>2]|0)+120>>2]&1](c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[j>>2]|0)+100>>2]|0,c[(c[j>>2]|0)+96>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0)|0}do{if((c[t>>2]|0)!=0){l=c[j>>2]|0;do{if((c[t>>2]|0)!=4272){c[s>>2]=Tb[c[(c[l+8>>2]|0)+124>>2]&15](c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[t>>2]|0)|0;if((c[s>>2]|0)!=0){break}else{Ga(4040,2264,914,4056)}}else{c[s>>2]=c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[l+52>>2]|0)-1|0)*12|0)>>2]}}while(0);if((c[s>>2]|0)==(c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0)){xe(c[j>>2]|0);De(c[j>>2]|0);break}if((c[s>>2]|0)!=0){Ce(c[j>>2]|0);ze(c[j>>2]|0);if((c[(c[j>>2]|0)+44>>2]|0)>=(c[(c[j>>2]|0)+48>>2]|0)){c[(c[j>>2]|0)+48>>2]=(c[(c[j>>2]|0)+44>>2]|0)+128;l=oe(c[(c[j>>2]|0)+56>>2]|0,(c[(c[j>>2]|0)+48>>2]|0)*12|0)|0;c[(c[j>>2]|0)+56>>2]=l}if((c[t>>2]|0)==0){Ga(4088,2264,930,4056)}c[(c[(c[j>>2]|0)+56>>2]|0)+((c[(c[j>>2]|0)+44>>2]|0)*12|0)>>2]=c[s>>2];c[(c[(c[j>>2]|0)+56>>2]|0)+((c[(c[j>>2]|0)+44>>2]|0)*12|0)+4>>2]=c[t>>2];c[(c[(c[j>>2]|0)+56>>2]|0)+((c[(c[j>>2]|0)+44>>2]|0)*12|0)+8>>2]=1;l=(c[j>>2]|0)+44|0;k=(c[l>>2]|0)+1|0;c[l>>2]=k;c[(c[j>>2]|0)+52>>2]=k;c[(c[j>>2]|0)+124>>2]=1;if((c[(c[j>>2]|0)+100>>2]|0)!=0){Qb[c[(c[(c[j>>2]|0)+8>>2]|0)+116>>2]&7](c[(c[j>>2]|0)+100>>2]|0,c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0,c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0);u=29}else{u=29}}}else{if((c[m>>2]|0)==110|(c[m>>2]|0)==78|(c[m>>2]|0)==14|(c[m>>2]|0)==529){ye(c[j>>2]|0);xe(c[j>>2]|0);break}if((c[m>>2]|0)==117|(c[m>>2]|0)==85|(c[m>>2]|0)==26|(c[m>>2]|0)==31|(c[m>>2]|0)==531){Ce(c[j>>2]|0);c[o>>2]=c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)+8>>2];a[p]=1;if(ff(c[j>>2]|0)|0){u=29;break}else{break}}if((c[m>>2]|0)==114|(c[m>>2]|0)==82|(c[m>>2]|0)==18|(c[m>>2]|0)==25|(c[m>>2]|0)==532){Ce(c[j>>2]|0);if(gf(c[j>>2]|0)|0){u=29;break}else{break}}if((c[m>>2]|0)==19|(c[m>>2]|0)==530?a[(c[(c[j>>2]|0)+8>>2]|0)+76|0]&1:0){if((bf(c[j>>2]|0)|0)!=0){break}else{u=29;break}}if((c[m>>2]|0)==113|(c[m>>2]|0)==81|(c[m>>2]|0)==17|(c[m>>2]|0)==528){a[q]=0}}}while(0);if((u|0)==29){if(!(a[p]&1)){c[o>>2]=c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)+8>>2]}do{if((c[o>>2]|0)!=1){if((c[o>>2]|0)==2?(c[(c[(c[j>>2]|0)+8>>2]|0)+188>>2]&512|0)!=0:0){u=35;break}g[r>>2]=0.0}else{u=35}}while(0);if((u|0)==35){g[r>>2]=+Ub[c[(c[(c[j>>2]|0)+8>>2]|0)+156>>2]&3](c[n>>2]|0,c[(c[(c[j>>2]|0)+56>>2]|0)+(((c[(c[j>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[j>>2]|0)+124>>2]|0,c[(c[j>>2]|0)+100>>2]|0)}c[(c[j>>2]|0)+104>>2]=c[n>>2];c[n>>2]=0;if(+g[r>>2]>0.0){g[(c[j>>2]|0)+108>>2]=+g[r>>2]}else{g[(c[j>>2]|0)+108>>2]=0.0;Ge(c[j>>2]|0)}g[(c[j>>2]|0)+112>>2]=0.0;xe(c[j>>2]|0);De(c[j>>2]|0)}if((c[n>>2]|0)==0){v=a[q]|0;w=v&1;i=h;return w|0}Jb[c[(c[(c[j>>2]|0)+8>>2]|0)+72>>2]&7](c[n>>2]|0);v=a[q]|0;w=v&1;i=h;return w|0}function Ke(b,d){b=b|0;d=+d;var e=0,f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;e=i;i=i+16|0;f=e+8|0;h=e+4|0;j=e+12|0;k=e;c[f>>2]=b;g[h>>2]=d;if(+g[(c[f>>2]|0)+108>>2]>0.0){l=1}else{l=+g[(c[f>>2]|0)+116>>2]>0.0}a[j]=l&1;l=(c[f>>2]|0)+112|0;g[l>>2]=+g[l>>2]+ +g[h>>2];if(!((!(+g[(c[f>>2]|0)+112>>2]>=+g[(c[f>>2]|0)+108>>2])?!(+g[(c[f>>2]|0)+108>>2]==0.0):0)?(c[(c[f>>2]|0)+104>>2]|0)!=0:0)){m=6}if((m|0)==6?+g[(c[f>>2]|0)+108>>2]>0.0:0){Ge(c[f>>2]|0)}m=(c[f>>2]|0)+120|0;g[m>>2]=+g[m>>2]+ +g[h>>2];if(!(!(+g[(c[f>>2]|0)+120>>2]>=+g[(c[f>>2]|0)+116>>2])?!(+g[(c[f>>2]|0)+116>>2]==0.0):0)){g[(c[f>>2]|0)+116>>2]=0.0;g[(c[f>>2]|0)+120>>2]=0.0}if(a[j]&1){xe(c[f>>2]|0)}if(!(a[(c[f>>2]|0)+128|0]&1)){n=c[f>>2]|0;De(n);i=e;return}g[k>>2]=+g[(c[f>>2]|0)+132>>2];j=(c[f>>2]|0)+132|0;g[j>>2]=+g[j>>2]+ +g[h>>2];if((~~+g[k>>2]|0)==(~~+g[(c[f>>2]|0)+132>>2]|0)){n=c[f>>2]|0;De(n);i=e;return}if((c[(c[f>>2]|0)+136>>2]|0)!=0){o=c[(c[f>>2]|0)+136>>2]|0}else{o=2416}uc(c[(c[f>>2]|0)+140>>2]|0,o);n=c[f>>2]|0;De(n);i=e;return}function Le(b,e){b=b|0;e=e|0;var f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0;f=i;i=i+144|0;h=f;j=f+48|0;k=f+44|0;l=f+40|0;m=f+36|0;n=f+56|0;o=f+32|0;p=f+28|0;q=f+24|0;r=f+20|0;s=f+16|0;t=f+12|0;c[j>>2]=b;c[k>>2]=e;c[l>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+140>>2]&15](c[c[j>>2]>>2]|0,c[k>>2]|0)|0;c[m>>2]=0;while(1){if((c[m>>2]|0)>=(c[c[k>>2]>>2]|0)){break}e=c[m>>2]|0;c[h>>2]=c[c[(c[j>>2]|0)+8>>2]>>2];c[h+4>>2]=e;fb(n|0,2424,h|0)|0;c[t>>2]=0;c[s>>2]=0;while(1){if((a[n+(c[s>>2]|0)|0]|0)==0){break}if((bb(d[n+(c[s>>2]|0)|0]|0)|0)==0){e=(ib(d[n+(c[s>>2]|0)|0]|0)|0)&255;b=c[t>>2]|0;c[t>>2]=b+1;a[n+b|0]=e}c[s>>2]=(c[s>>2]|0)+1}a[n+(c[t>>2]|0)|0]=0;e=eb(n|0)|0;c[o>>2]=e;if((e|0)!=0?(e=c[o>>2]|0,c[h>>2]=p,c[h+4>>2]=q,c[h+8>>2]=r,(Na(e|0,2440,h|0)|0)==3):0){g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+0<<2)>>2]=+((c[p>>2]|0)>>>0)/255.0;g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+1<<2)>>2]=+((c[q>>2]|0)>>>0)/255.0;g[(c[l>>2]|0)+(((c[m>>2]|0)*3|0)+2<<2)>>2]=+((c[r>>2]|0)>>>0)/255.0}c[m>>2]=(c[m>>2]|0)+1}i=f;return c[l>>2]|0}function Me(){var a=0,b=0;a=i;i=i+16|0;b=a;c[b>>2]=me(12)|0;c[c[b>>2]>>2]=0;c[(c[b>>2]|0)+4>>2]=0;c[(c[b>>2]|0)+8>>2]=0;i=a;return c[b>>2]|0}function Ne(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=Oe(c[e>>2]|0,c[f>>2]|0)|0;f=Me()|0;c[(c[g>>2]|0)+8>>2]=f;i=d;return c[(c[g>>2]|0)+8>>2]|0}function Oe(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;if((c[c[e>>2]>>2]|0)>=(c[(c[e>>2]|0)+4>>2]|0)){c[(c[e>>2]|0)+4>>2]=(((c[c[e>>2]>>2]|0)*5|0)/4|0)+10;b=oe(c[(c[e>>2]|0)+8>>2]|0,c[(c[e>>2]|0)+4>>2]<<4)|0;c[(c[e>>2]|0)+8>>2]=b}b=c[e>>2]|0;a=c[b>>2]|0;c[b>>2]=a+1;c[g>>2]=(c[(c[e>>2]|0)+8>>2]|0)+(a<<4);c[c[g>>2]>>2]=c[f>>2];c[(c[g>>2]|0)+4>>2]=0;c[(c[g>>2]|0)+8>>2]=0;i=d;return c[g>>2]|0}function Pe(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+16|0;f=e+12|0;g=e+8|0;h=e+4|0;j=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;c[j>>2]=Oe(c[f>>2]|0,c[g>>2]|0)|0;c[(c[j>>2]|0)+4>>2]=c[h>>2];i=e;return}function Qe(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0;f=i;i=i+128|0;g=f;h=f+36|0;j=f+32|0;k=f+28|0;l=f+24|0;m=f+20|0;n=f+16|0;o=f+40|0;p=f+12|0;q=f+8|0;r=f+4|0;c[j>>2]=b;c[k>>2]=e;e=c[j>>2]|0;if((c[(c[j>>2]|0)+12>>2]|0)!=0){c[h>>2]=c[e+12>>2];s=c[h>>2]|0;i=f;return s|0}b=c[(c[(c[j>>2]|0)+8>>2]|0)+20>>2]|0;a:do{if((c[(c[e+8>>2]|0)+16>>2]|0)!=0){if((b|0)!=0){Ga(2456,2264,1387,2488)}t=Me()|0;c[(c[j>>2]|0)+12>>2]=t;c[l>>2]=0;while(1){if(!(Pb[c[(c[(c[j>>2]|0)+8>>2]|0)+16>>2]&7](c[l>>2]|0,m,n)|0)){break a}Pe(c[(c[j>>2]|0)+12>>2]|0,c[m>>2]|0,c[n>>2]|0);c[l>>2]=(c[l>>2]|0)+1}}else{t=Ib[b&1]()|0;c[(c[j>>2]|0)+12>>2]=t}}while(0);c[g>>2]=c[c[(c[j>>2]|0)+8>>2]>>2];fb(o|0,2512,g|0)|0;c[r>>2]=0;c[q>>2]=0;while(1){if((a[o+(c[q>>2]|0)|0]|0)==0){break}if((bb(d[o+(c[q>>2]|0)|0]|0)|0)==0){g=(ib(d[o+(c[q>>2]|0)|0]|0)|0)&255;b=c[r>>2]|0;c[r>>2]=b+1;a[o+b|0]=g}c[q>>2]=(c[q>>2]|0)+1}a[o+(c[r>>2]|0)|0]=0;r=eb(o|0)|0;c[p>>2]=r;if((r|0)!=0){c[p>>2]=pe(c[p>>2]|0)|0;Re(c[j>>2]|0,c[(c[j>>2]|0)+12>>2]|0,c[p>>2]|0,1)|0;ne(c[p>>2]|0)}c[(c[j>>2]|0)+20>>2]=0;Se(c[j>>2]|0,c[(c[j>>2]|0)+12>>2]|0);p=me(c[(c[j>>2]|0)+20>>2]<<2)|0;c[(c[j>>2]|0)+16>>2]=p;c[l>>2]=0;while(1){if((c[l>>2]|0)>=(c[(c[j>>2]|0)+20>>2]|0)){break}c[(c[(c[j>>2]|0)+16>>2]|0)+(c[l>>2]<<2)>>2]=0;c[l>>2]=(c[l>>2]|0)+1}Te(c[j>>2]|0,c[(c[j>>2]|0)+12>>2]|0);if((c[k>>2]|0)!=0){c[c[k>>2]>>2]=c[(c[j>>2]|0)+20>>2]}c[h>>2]=c[(c[j>>2]|0)+12>>2];s=c[h>>2]|0;i=f;return s|0}function Re(b,d,e,f){b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0;g=i;i=i+48|0;h=g+28|0;j=g+24|0;k=g+20|0;l=g+16|0;m=g+32|0;n=g+12|0;o=g+8|0;p=g+4|0;q=g;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;a[m]=f&1;while(1){r=c[l>>2]|0;if((a[c[l>>2]|0]|0)==0){s=25;break}c[n>>2]=r;while(1){if((a[c[l>>2]|0]|0)!=0){t=(a[c[l>>2]|0]|0)!=58}else{t=0}u=c[l>>2]|0;if(!t){break}c[l>>2]=u+1}if((a[u]|0)!=0){f=c[l>>2]|0;c[l>>2]=f+1;a[f]=0}c[o>>2]=c[l>>2];while(1){if((a[c[l>>2]|0]|0)!=0){v=(a[c[l>>2]|0]|0)!=58}else{v=0}w=c[l>>2]|0;if(!v){break}c[l>>2]=w+1}if((a[w]|0)!=0){f=c[l>>2]|0;c[l>>2]=f+1;a[f]=0}if((Yf(c[o>>2]|0,4032)|0)!=0){c[p>>2]=Ib[c[(c[(c[j>>2]|0)+8>>2]|0)+12>>2]&1]()|0;Kb[c[(c[(c[j>>2]|0)+8>>2]|0)+24>>2]&7](c[p>>2]|0,c[o>>2]|0);if((Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+52>>2]&15](c[p>>2]|0,1)|0)!=0){Jb[c[(c[(c[j>>2]|0)+8>>2]|0)+32>>2]&7](c[p>>2]|0);continue}else{f=c[k>>2]|0;e=pe(c[n>>2]|0)|0;Pe(f,e,c[p>>2]|0);continue}}else{if((a[c[n>>2]|0]|0)==0){if(a[m]&1){continue}else{s=21;break}}else{e=c[k>>2]|0;c[q>>2]=Ne(e,pe(c[n>>2]|0)|0)|0;c[l>>2]=Re(c[j>>2]|0,c[q>>2]|0,c[l>>2]|0,0)|0;continue}}}if((s|0)==21){c[h>>2]=c[l>>2];x=c[h>>2]|0;i=g;return x|0}else if((s|0)==25){c[h>>2]=r;x=c[h>>2]|0;i=g;return x|0}return 0}function Se(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=0;while(1){if((c[g>>2]|0)>=(c[c[f>>2]>>2]|0)){break}b=(c[e>>2]|0)+20|0;a=c[b>>2]|0;c[b>>2]=a+1;c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+12>>2]=a;c[g>>2]=(c[g>>2]|0)+1}c[g>>2]=0;while(1){if((c[g>>2]|0)>=(c[c[f>>2]>>2]|0)){break}if((c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+8>>2]|0)!=0){Se(c[e>>2]|0,c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+8>>2]|0)}c[g>>2]=(c[g>>2]|0)+1}i=d;return}function Te(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=0;while(1){if((c[g>>2]|0)>=(c[c[f>>2]>>2]|0)){break}b=c[e>>2]|0;if((c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+4>>2]|0)!=0){a=Tb[c[(c[b+8>>2]|0)+28>>2]&15](c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+4>>2]|0,1)|0;c[(c[(c[e>>2]|0)+16>>2]|0)+(c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+12>>2]<<2)>>2]=a}else{Te(b,c[(c[(c[f>>2]|0)+8>>2]|0)+(c[g>>2]<<4)+8>>2]|0)}c[g>>2]=(c[g>>2]|0)+1}i=d;return}function Ue(a){a=a|0;var b=0,d=0,e=0,f=0,g=0,h=0,j=0,k=0;b=i;i=i+16|0;d=b+12|0;e=b+8|0;f=b+4|0;g=b;c[d>>2]=a;c[e>>2]=Tb[c[(c[(c[d>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[d>>2]|0)+88>>2]|0,1)|0;c[g>>2]=-1;c[f>>2]=0;while(1){if((c[f>>2]|0)>=(c[(c[d>>2]|0)+20>>2]|0)){h=7;break}if((c[(c[(c[d>>2]|0)+16>>2]|0)+(c[f>>2]<<2)>>2]|0)!=0?(Yf(c[e>>2]|0,c[(c[(c[d>>2]|0)+16>>2]|0)+(c[f>>2]<<2)>>2]|0)|0)==0:0){break}c[f>>2]=(c[f>>2]|0)+1}if((h|0)==7){j=c[e>>2]|0;ne(j);k=c[g>>2]|0;i=b;return k|0}c[g>>2]=c[f>>2];j=c[e>>2]|0;ne(j);k=c[g>>2]|0;i=b;return k|0}function Ve(b){b=b|0;var d=0,e=0;d=i;i=i+16|0;e=d;c[e>>2]=b;i=d;return a[(c[(c[e>>2]|0)+8>>2]|0)+180|0]&1|0}function We(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;c[(c[f>>2]|0)+164>>2]=c[g>>2];c[(c[f>>2]|0)+168>>2]=c[h>>2];i=e;return}function Xe(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0;f=i;i=i+48|0;g=f;h=f+40|0;j=f+36|0;k=f+32|0;l=f+28|0;m=f+24|0;n=f+20|0;o=f+16|0;p=f+12|0;q=f+44|0;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;if((c[l>>2]|0)==0){Ga(2528,2264,1485,2544)}c[m>>2]=me(40+(dg(c[c[(c[j>>2]|0)+8>>2]>>2]|0)|0)|0)|0;e=c[k>>2]|0;if((e|0)==2|(e|0)==1){d=c[m>>2]|0;if((c[(c[j>>2]|0)+92>>2]|0)==0){ne(d);c[h>>2]=0;r=c[h>>2]|0;i=f;return r|0}b=(c[k>>2]|0)==1?2608:2616;c[g>>2]=c[c[(c[j>>2]|0)+8>>2]>>2];c[g+4>>2]=b;fb(d|0,2592,g|0)|0;c[c[l>>2]>>2]=c[m>>2];c[p>>2]=me(32)|0;c[(c[p>>2]|0)+4>>2]=0;d=c[p>>2]|0;if((c[k>>2]|0)==1){c[d>>2]=2624}else{c[d>>2]=2648}c[n>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[j>>2]|0)+92>>2]|0,(c[k>>2]|0)==1)|0;if((c[n>>2]|0)==0){Ga(2656,2264,1520,2544)}d=c[j>>2]|0;if((c[k>>2]|0)==2){if((c[d+24>>2]|0)!=0){s=c[(c[j>>2]|0)+24>>2]|0}else{s=2416}c[o>>2]=s;a[q]=58}else{if((c[d+32>>2]|0)!=0){t=c[(c[j>>2]|0)+32>>2]|0}else{t=2416}c[o>>2]=t;a[q]=35}t=dg(c[n>>2]|0)|0;d=me(t+(dg(c[o>>2]|0)|0)+2|0)|0;c[(c[p>>2]|0)+8>>2]=d;d=c[(c[p>>2]|0)+8>>2]|0;t=a[q]|0;q=c[o>>2]|0;c[g>>2]=c[n>>2];c[g+4>>2]=t;c[g+8>>2]=q;fb(d|0,2664,g|0)|0;ne(c[n>>2]|0);c[(c[p>>2]|0)+20>>2]=3;c[(c[p>>2]|0)+16>>2]=0;c[h>>2]=c[p>>2];r=c[h>>2]|0;i=f;return r|0}else if((e|0)==0){e=c[m>>2]|0;c[g>>2]=c[c[(c[j>>2]|0)+8>>2]>>2];fb(e|0,2568,g|0)|0;c[c[l>>2]>>2]=c[m>>2];c[h>>2]=Ob[c[(c[(c[j>>2]|0)+8>>2]|0)+44>>2]&15](c[(c[j>>2]|0)+88>>2]|0)|0;r=c[h>>2]|0;i=f;return r|0}else{Ga(2672,2264,1538,2544)}return 0}function Ye(a,b){a=a|0;b=b|0;var d=0,e=0,f=0;d=i;i=i+16|0;e=d+4|0;f=d;c[e>>2]=a;c[f>>2]=b;b=Ze(c[e>>2]|0,c[f>>2]|0,0)|0;i=d;return b|0}function Ze(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0;f=i;i=i+64|0;g=f+48|0;h=f+44|0;j=f+40|0;k=f+36|0;l=f+32|0;m=f+28|0;n=f+24|0;o=f+20|0;p=f+16|0;q=f+12|0;r=f+8|0;s=f+4|0;t=f+52|0;u=f;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[m>>2]=0;c[o>>2]=Ff(c[j>>2]|0,35)|0;c[n>>2]=Ff(c[j>>2]|0,58)|0;do{if((c[n>>2]|0)!=0){if((c[o>>2]|0)!=0?!((c[n>>2]|0)>>>0<(c[o>>2]|0)>>>0):0){v=5;break}c[m>>2]=me((c[n>>2]|0)-(c[j>>2]|0)+1|0)|0;ag(c[m>>2]|0,c[j>>2]|0,(c[n>>2]|0)-(c[j>>2]|0)|0)|0;a[(c[m>>2]|0)+((c[n>>2]|0)-(c[j>>2]|0))|0]=0;c[n>>2]=(c[n>>2]|0)+1;c[o>>2]=0}else{v=5}}while(0);a:do{if((v|0)==5){do{if((c[o>>2]|0)!=0){if((c[n>>2]|0)!=0?!((c[o>>2]|0)>>>0<(c[n>>2]|0)>>>0):0){break}c[m>>2]=me((c[o>>2]|0)-(c[j>>2]|0)+1|0)|0;ag(c[m>>2]|0,c[j>>2]|0,(c[o>>2]|0)-(c[j>>2]|0)|0)|0;a[(c[m>>2]|0)+((c[o>>2]|0)-(c[j>>2]|0))|0]=0;c[o>>2]=(c[o>>2]|0)+1;c[n>>2]=0;break a}}while(0);if((c[k>>2]|0)==1){c[o>>2]=c[j>>2];c[m>>2]=0;c[n>>2]=0;break}e=c[j>>2]|0;if((c[k>>2]|0)==2){c[n>>2]=e;c[m>>2]=0;c[o>>2]=0;break}else{c[m>>2]=pe(e)|0;c[n>>2]=0;c[o>>2]=0;break}}}while(0);c[s>>2]=0;c[r>>2]=0;c[q>>2]=0;c[p>>2]=0;if((c[m>>2]|0)!=0){k=c[(c[h>>2]|0)+8>>2]|0;if((c[n>>2]|0)!=0){c[p>>2]=Ob[c[k+36>>2]&15](c[(c[h>>2]|0)+88>>2]|0)|0}else{c[p>>2]=Ib[c[k+12>>2]&1]()|0}Kb[c[(c[(c[h>>2]|0)+8>>2]|0)+24>>2]&7](c[p>>2]|0,c[m>>2]|0);c[l>>2]=Tb[c[(c[(c[h>>2]|0)+8>>2]|0)+52>>2]&15](c[p>>2]|0,(c[n>>2]|0)==0)|0;k=c[h>>2]|0;if((c[l>>2]|0)!=0){Jb[c[(c[k+8>>2]|0)+32>>2]&7](c[p>>2]|0);c[g>>2]=c[l>>2];w=c[g>>2]|0;i=f;return w|0}c[r>>2]=c[k+92>>2];c[s>>2]=c[(c[h>>2]|0)+88>>2];if((c[o>>2]|0)==0?(c[n>>2]|0)==0:0){c[q>>2]=Ob[c[(c[(c[h>>2]|0)+8>>2]|0)+36>>2]&15](c[p>>2]|0)|0}else{c[q>>2]=Ob[c[(c[(c[h>>2]|0)+8>>2]|0)+36>>2]&15](c[(c[h>>2]|0)+88>>2]|0)|0;c[u>>2]=Tb[c[(c[(c[h>>2]|0)+8>>2]|0)+28>>2]&15](c[p>>2]|0,0)|0;Kb[c[(c[(c[h>>2]|0)+8>>2]|0)+24>>2]&7](c[q>>2]|0,c[u>>2]|0);ne(c[u>>2]|0)}a[t]=1}else{c[p>>2]=c[(c[h>>2]|0)+92>>2];c[q>>2]=c[(c[h>>2]|0)+88>>2];a[t]=0}if((c[n>>2]|0)!=0?(c[l>>2]=Tb[c[(c[(c[h>>2]|0)+8>>2]|0)+60>>2]&15](c[q>>2]|0,c[n>>2]|0)|0,(c[l>>2]|0)!=0):0){if(a[t]&1){if((c[p>>2]|0)!=0){Jb[c[(c[(c[h>>2]|0)+8>>2]|0)+32>>2]&7](c[p>>2]|0)}if((c[q>>2]|0)!=0){Jb[c[(c[(c[h>>2]|0)+8>>2]|0)+32>>2]&7](c[q>>2]|0)}}c[g>>2]=c[l>>2];w=c[g>>2]|0;i=f;return w|0}c[(c[h>>2]|0)+88>>2]=c[q>>2];c[(c[h>>2]|0)+92>>2]=c[p>>2];if((c[r>>2]|0)!=0){Jb[c[(c[(c[h>>2]|0)+8>>2]|0)+32>>2]&7](c[r>>2]|0)}if((c[s>>2]|0)!=0){Jb[c[(c[(c[h>>2]|0)+8>>2]|0)+32>>2]&7](c[s>>2]|0)}ne(c[(c[h>>2]|0)+24>>2]|0);ne(c[(c[h>>2]|0)+28>>2]|0);c[(c[h>>2]|0)+28>>2]=0;c[(c[h>>2]|0)+24>>2]=0;ne(c[(c[h>>2]|0)+32>>2]|0);c[(c[h>>2]|0)+32>>2]=0;if((c[n>>2]|0)!=0){s=pe(c[n>>2]|0)|0;c[(c[h>>2]|0)+24>>2]=s;c[(c[h>>2]|0)+40>>2]=1;ne(c[(c[h>>2]|0)+36>>2]|0);c[(c[h>>2]|0)+36>>2]=0}if((c[o>>2]|0)!=0){s=pe(c[o>>2]|0)|0;c[(c[h>>2]|0)+32>>2]=s;c[(c[h>>2]|0)+40>>2]=0}ne(c[m>>2]|0);a[(c[h>>2]|0)+84|0]=0;c[g>>2]=0;w=c[g>>2]|0;i=f;return w|0}function _e(a){a=a|0;var b=0,d=0,e=0,f=0,g=0,h=0;b=i;i=i+32|0;d=b;e=b+16|0;f=b+12|0;g=b+8|0;c[e>>2]=a;c[f>>2]=Tb[c[(c[(c[e>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[e>>2]|0)+92>>2]|0,0)|0;if((c[f>>2]|0)==0){Ga(2656,2264,1736,2696)}if((c[(c[e>>2]|0)+24>>2]|0)!=0){a=dg(c[f>>2]|0)|0;c[g>>2]=me(a+(dg(c[(c[e>>2]|0)+24>>2]|0)|0)+2|0)|0;a=c[g>>2]|0;h=c[(c[e>>2]|0)+24>>2]|0;c[d>>2]=c[f>>2];c[d+4>>2]=h;fb(a|0,2736,d|0)|0;ne(c[f>>2]|0);i=b;return c[g>>2]|0}else{Ga(2720,2264,1737,2696)}return 0}function $e(a){a=a|0;var b=0,d=0,e=0,f=0,g=0,h=0,j=0,k=0;b=i;i=i+32|0;d=b;e=b+20|0;f=b+16|0;g=b+12|0;h=b+8|0;c[f>>2]=a;if((c[(c[f>>2]|0)+32>>2]|0)==0){c[e>>2]=0;j=c[e>>2]|0;i=b;return j|0}c[g>>2]=Tb[c[(c[(c[f>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[f>>2]|0)+92>>2]|0,1)|0;if((c[g>>2]|0)==0){Ga(2656,2264,1752,2744)}a=dg(c[g>>2]|0)|0;c[h>>2]=me(a+(dg(c[(c[f>>2]|0)+32>>2]|0)|0)+2|0)|0;a=c[h>>2]|0;k=c[(c[f>>2]|0)+32>>2]|0;c[d>>2]=c[g>>2];c[d+4>>2]=k;fb(a|0,2768,d|0)|0;ne(c[g>>2]|0);c[e>>2]=c[h>>2];j=c[e>>2]|0;i=b;return j|0}function af(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0;e=i;i=i+32|0;f=e+20|0;g=e+16|0;h=e+12|0;j=e+8|0;k=e+4|0;l=e;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;d=c[h>>2]|0;do{if((d|0)==2|(d|0)==1){c[k>>2]=Ze(c[g>>2]|0,c[(c[j>>2]|0)+8>>2]|0,(c[h>>2]|0)==1?1:2)|0;if((c[k>>2]|0)!=0){c[f>>2]=c[k>>2];m=c[f>>2]|0;i=e;return m|0}}else if((d|0)==0){c[l>>2]=Ob[c[(c[(c[g>>2]|0)+8>>2]|0)+48>>2]&15](c[j>>2]|0)|0;c[k>>2]=Tb[c[(c[(c[g>>2]|0)+8>>2]|0)+52>>2]&15](c[l>>2]|0,1)|0;b=c[(c[(c[g>>2]|0)+8>>2]|0)+32>>2]|0;if((c[k>>2]|0)==0){Jb[b&7](c[(c[g>>2]|0)+88>>2]|0);c[(c[g>>2]|0)+88>>2]=c[l>>2];break}Jb[b&7](c[l>>2]|0);c[f>>2]=c[k>>2];m=c[f>>2]|0;i=e;return m|0}}while(0);c[f>>2]=0;m=c[f>>2]|0;i=e;return m|0}function bf(b){b=b|0;var d=0,e=0,f=0,h=0,j=0,k=0,l=0,m=0.0;d=i;i=i+32|0;e=d+16|0;f=d+12|0;h=d+8|0;j=d+4|0;k=d;c[f>>2]=b;if(!(a[(c[(c[f>>2]|0)+8>>2]|0)+76|0]&1)){c[e>>2]=2776;l=c[e>>2]|0;i=d;return l|0}if((c[(c[f>>2]|0)+52>>2]|0)<1){c[e>>2]=2824;l=c[e>>2]|0;i=d;return l|0}c[j>>2]=0;c[k>>2]=Gb[c[(c[(c[f>>2]|0)+8>>2]|0)+80>>2]&3](c[c[(c[f>>2]|0)+56>>2]>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[f>>2]|0)+36>>2]|0,j)|0;if((c[k>>2]|0)==4272){Ga(2848,2264,1823,2872)}if((c[k>>2]|0)==0){if((c[j>>2]|0)==0){c[j>>2]=2888}c[e>>2]=c[j>>2];l=c[e>>2]|0;i=d;return l|0}c[h>>2]=Tb[c[(c[(c[f>>2]|0)+8>>2]|0)+124>>2]&15](c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[k>>2]|0)|0;if((c[h>>2]|0)==0){Ga(2312,2264,1830,2872)}Ce(c[f>>2]|0);ze(c[f>>2]|0);if((c[(c[f>>2]|0)+44>>2]|0)>=(c[(c[f>>2]|0)+48>>2]|0)){c[(c[f>>2]|0)+48>>2]=(c[(c[f>>2]|0)+44>>2]|0)+128;j=oe(c[(c[f>>2]|0)+56>>2]|0,(c[(c[f>>2]|0)+48>>2]|0)*12|0)|0;c[(c[f>>2]|0)+56>>2]=j}c[(c[(c[f>>2]|0)+56>>2]|0)+((c[(c[f>>2]|0)+44>>2]|0)*12|0)>>2]=c[h>>2];c[(c[(c[f>>2]|0)+56>>2]|0)+((c[(c[f>>2]|0)+44>>2]|0)*12|0)+4>>2]=c[k>>2];c[(c[(c[f>>2]|0)+56>>2]|0)+((c[(c[f>>2]|0)+44>>2]|0)*12|0)+8>>2]=2;k=(c[f>>2]|0)+44|0;h=(c[k>>2]|0)+1|0;c[k>>2]=h;c[(c[f>>2]|0)+52>>2]=h;if((c[(c[f>>2]|0)+100>>2]|0)!=0){Qb[c[(c[(c[f>>2]|0)+8>>2]|0)+116>>2]&7](c[(c[f>>2]|0)+100>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0)}c[(c[f>>2]|0)+124>>2]=1;h=c[f>>2]|0;if((c[(c[(c[f>>2]|0)+8>>2]|0)+188>>2]&512|0)!=0){k=Ob[c[(c[h+8>>2]|0)+68>>2]&15](c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0)|0;c[(c[f>>2]|0)+104>>2]=k;m=+Ub[c[(c[(c[f>>2]|0)+8>>2]|0)+156>>2]&3](c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,1,c[(c[f>>2]|0)+100>>2]|0);g[(c[f>>2]|0)+108>>2]=m;g[(c[f>>2]|0)+112>>2]=0.0}else{g[h+108>>2]=0.0;Ge(c[f>>2]|0)}if((c[(c[f>>2]|0)+140>>2]|0)!=0){xe(c[f>>2]|0)}De(c[f>>2]|0);c[e>>2]=0;l=c[e>>2]|0;i=d;return l|0}function cf(b,d){b=b|0;d=d|0;var e=0,f=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0;e=i;i=i+144|0;f=e;h=e+28|0;j=e+24|0;k=e+20|0;l=e+32|0;m=e+16|0;n=e+12|0;o=e+8|0;c[j>>2]=b;c[k>>2]=d;if((c[(c[j>>2]|0)+136>>2]|0)!=(c[k>>2]|0)){ne(c[(c[j>>2]|0)+136>>2]|0);d=pe(c[k>>2]|0)|0;c[(c[j>>2]|0)+136>>2]=d}if(a[(c[(c[j>>2]|0)+8>>2]|0)+181|0]&1){c[o>>2]=~~+g[(c[j>>2]|0)+132>>2];c[n>>2]=(c[o>>2]|0)/60|0;c[o>>2]=(c[o>>2]|0)%60|0;j=c[o>>2]|0;c[f>>2]=c[n>>2];c[f+4>>2]=j;fb(l|0,2912,f|0)|0;f=dg(l|0)|0;c[m>>2]=me(f+(dg(c[k>>2]|0)|0)+1|0)|0;hg(c[m>>2]|0,l|0)|0;fg(c[m>>2]|0,c[k>>2]|0)|0;c[h>>2]=c[m>>2];p=c[h>>2]|0;i=e;return p|0}else{c[h>>2]=pe(c[k>>2]|0)|0;p=c[h>>2]|0;i=e;return p|0}return 0}function df(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0;e=i;i=i+16|0;f=e+8|0;g=e+4|0;h=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;d=ef(c[f>>2]|0,c[g>>2]|0,c[h>>2]|0,0,0)|0;i=e;return d|0}



    function ef(b,d,e,f,h){b=b|0;d=d|0;e=e|0;f=f|0;h=h|0;var j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0;j=i;i=i+144|0;k=j+120|0;l=j+116|0;m=j+112|0;n=j+108|0;o=j+104|0;p=j+48|0;q=j+44|0;r=j+134|0;s=j+40|0;t=j+36|0;u=j+32|0;v=j+125|0;w=j+124|0;x=j+28|0;y=j+24|0;z=j+20|0;A=j+16|0;B=j+12|0;C=j+8|0;D=j+4|0;E=j;c[k>>2]=b;c[l>>2]=d;c[m>>2]=e;c[n>>2]=f;c[o>>2]=h;c[q>>2]=0;a[r]=0;c[t>>2]=0;c[u>>2]=3224;c[p+12>>2]=0;c[p+8>>2]=0;c[p+4>>2]=0;c[p>>2]=0;c[p+24>>2]=0;c[p+20>>2]=0;c[p+16>>2]=0;g[p+28>>2]=0.0;c[p+36>>2]=0;c[p+32>>2]=0;c[p+40>>2]=0;c[p+44>>2]=0;c[p+48>>2]=0;c[p+52>>2]=-1;a:while(1){if(((c[p+48>>2]|0)>0?(c[p+52>>2]|0)>=0:0)?(c[q>>2]|0)>=((c[p+48>>2]|0)-1|0):0){F=67;break}while(1){if(!(Pb[c[l>>2]&7](c[m>>2]|0,v,1)|0)){break a}if((a[v]|0)==13){continue}if((a[v]|0)!=10){break}}if(!(Pb[c[l>>2]&7](c[m>>2]|0,v+1|0,8)|0)){break}if((a[v+8|0]|0)!=58){F=10;break}c[x>>2]=Hf(v,3328)|0;if((c[x>>2]|0)>8){F=13;break}a[v+(c[x>>2]|0)|0]=0;c[x>>2]=0;while(1){if(!(Pb[c[l>>2]&7](c[m>>2]|0,w,1)|0)){break a}if((a[w]|0)==58){break}if((a[w]|0)<48){F=20;break a}if((a[w]|0)>57){F=20;break a}c[x>>2]=((c[x>>2]|0)*10|0)+((a[w]|0)-48)}c[t>>2]=me((c[x>>2]|0)+1|0)|0;if(!(Pb[c[l>>2]&7](c[m>>2]|0,c[t>>2]|0,c[x>>2]|0)|0)?a[r]&1:0){break}a[(c[t>>2]|0)+(c[x>>2]|0)|0]=0;b:do{if(a[r]&1){if((Yf(v,3016)|0)==0){if((Yf(c[t>>2]|0,3008)|0)!=0){F=30;break a}else{break}}if((Yf(v,3024)|0)==0){if((Yf(c[t>>2]|0,c[c[(c[k>>2]|0)+8>>2]>>2]|0)|0)!=0){F=33;break a}else{break}}if((Yf(v,3032)|0)==0){ne(c[p+4>>2]|0);c[p+4>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3040)|0)==0){ne(c[p+24>>2]|0);c[p+24>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3048)|0)==0){ne(c[p>>2]|0);c[p>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3056)|0)==0){ne(c[p+8>>2]|0);c[p+8>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3064)|0)==0){ne(c[p+12>>2]|0);c[p+12>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3080)|0)==0){c[z>>2]=((dg(c[t>>2]|0)|0)>>>0)/2|0;c[y>>2]=nf(c[t>>2]|0,c[z>>2]|0)|0;lf(c[y>>2]|0,c[z>>2]<<3,1);ne(c[p+16>>2]|0);c[p+16>>2]=me((c[z>>2]|0)+1|0)|0;bg(c[p+16>>2]|0,c[y>>2]|0,c[z>>2]|0)|0;a[(c[p+16>>2]|0)+(c[z>>2]|0)|0]=0;ne(c[y>>2]|0);break}if((Yf(v,3088)|0)==0){ne(c[p+20>>2]|0);c[p+20>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3104)|0)==0){g[p+28>>2]=+Vf(c[t>>2]|0);break}if((Yf(v,3112)|0)==0){c[p+48>>2]=Wf(c[t>>2]|0)|0;if((c[p+48>>2]|0)<=0){F=52;break a}if((c[p+44>>2]|0)!=0){F=54;break a}c[p+44>>2]=me((c[p+48>>2]|0)*12|0)|0;c[s>>2]=0;while(1){if((c[s>>2]|0)>=(c[p+48>>2]|0)){break b}c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)>>2]=0;c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+4>>2]=0;c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+8>>2]=0;c[s>>2]=(c[s>>2]|0)+1}}if((Yf(v,3120)|0)==0){c[p+52>>2]=Wf(c[t>>2]|0)|0;break}if((Yf(v,3200)|0)==0){c[q>>2]=(c[q>>2]|0)+1;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+8>>2]=1;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+4>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3208)|0)==0){c[q>>2]=(c[q>>2]|0)+1;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+8>>2]=2;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+4>>2]=c[t>>2];c[t>>2]=0;break}if((Yf(v,3216)|0)==0){c[q>>2]=(c[q>>2]|0)+1;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+8>>2]=3;c[(c[p+44>>2]|0)+((c[q>>2]|0)*12|0)+4>>2]=c[t>>2];c[t>>2]=0}}else{if((Yf(v,2976)|0)!=0){break a}if((Yf(c[t>>2]|0,2928)|0)!=0){break a}c[u>>2]=3352;a[r]=1}}while(0);ne(c[t>>2]|0);c[t>>2]=0}do{if((F|0)==10){if(a[r]&1){c[u>>2]=3272}}else if((F|0)==13){Ga(3336,2264,2121,3448)}else if((F|0)==20){if(a[r]&1){c[u>>2]=3272}}else if((F|0)==30){c[u>>2]=3384}else if((F|0)==33){c[u>>2]=3480}else if((F|0)==52){c[u>>2]=3520}else if((F|0)==54){c[u>>2]=3568}else if((F|0)==67){c[p+32>>2]=Ib[c[(c[(c[k>>2]|0)+8>>2]|0)+12>>2]&1]()|0;Kb[c[(c[(c[k>>2]|0)+8>>2]|0)+24>>2]&7](c[p+32>>2]|0,c[p+4>>2]|0);if((Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+52>>2]&15](c[p+32>>2]|0,1)|0)!=0){c[u>>2]=3608;break}c[p+36>>2]=Ib[c[(c[(c[k>>2]|0)+8>>2]|0)+12>>2]&1]()|0;Kb[c[(c[(c[k>>2]|0)+8>>2]|0)+24>>2]&7](c[p+36>>2]|0,c[p+24>>2]|0);if((Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+52>>2]&15](c[p+36>>2]|0,0)|0)!=0){c[u>>2]=3656;break}if((c[p>>2]|0)!=0?(Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+52>>2]&15](c[p+36>>2]|0,1)|0)!=0:0){ne(c[p>>2]|0);c[p>>2]=0}if((c[p+8>>2]|0)==0){c[u>>2]=3704;break}if((Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+60>>2]&15](c[p+36>>2]|0,c[p+8>>2]|0)|0)!=0){c[u>>2]=3752;break}if((c[p+12>>2]|0)!=0?(Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+60>>2]&15](c[p+36>>2]|0,c[p+12>>2]|0)|0)!=0:0){c[u>>2]=3800;break}if(!((c[p+52>>2]|0)>=0?(c[p+52>>2]|0)<(c[p+48>>2]|0):0)){c[u>>2]=3856}if((c[p+12>>2]|0)!=0){G=c[p+12>>2]|0}else{G=c[p+8>>2]|0}v=Pb[c[(c[(c[k>>2]|0)+8>>2]|0)+64>>2]&7](c[k>>2]|0,c[p+36>>2]|0,G)|0;c[c[p+44>>2]>>2]=v;c[s>>2]=1;while(1){if((c[s>>2]|0)>=(c[p+48>>2]|0)){F=98;break}if((c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+8>>2]|0)==0){F=90;break}v=c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+8>>2]|0;if((v|0)==3){if((Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+60>>2]&15](c[p+36>>2]|0,c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+4>>2]|0)|0)!=0){F=95;break}q=Pb[c[(c[(c[k>>2]|0)+8>>2]|0)+64>>2]&7](c[k>>2]|0,c[p+36>>2]|0,c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+4>>2]|0)|0;c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)>>2]=q}else if((v|0)==2|(v|0)==1?(v=Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+124>>2]&15](c[(c[p+44>>2]|0)+(((c[s>>2]|0)-1|0)*12|0)>>2]|0,c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)+4>>2]|0)|0,c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)>>2]=v,(c[(c[p+44>>2]|0)+((c[s>>2]|0)*12|0)>>2]|0)==0):0){F=93;break}c[s>>2]=(c[s>>2]|0)+1}if((F|0)==90){Ga(3904,2264,2286,3448)}else if((F|0)==93){c[u>>2]=3944;break}else if((F|0)==95){c[u>>2]=3984;break}else if((F|0)==98){c[p+40>>2]=Ob[c[(c[(c[k>>2]|0)+8>>2]|0)+96>>2]&15](c[c[p+44>>2]>>2]|0)|0;Kb[c[(c[(c[k>>2]|0)+8>>2]|0)+108>>2]&7](c[p+40>>2]|0,c[p+20>>2]|0);if((c[n>>2]|0)!=0?(v=Pb[c[n>>2]&7](c[o>>2]|0,c[k>>2]|0,p)|0,c[u>>2]=v,(v|0)!=0):0){break}c[A>>2]=c[(c[k>>2]|0)+24>>2];c[(c[k>>2]|0)+24>>2]=c[p+8>>2];c[p+8>>2]=c[A>>2];c[A>>2]=c[(c[k>>2]|0)+28>>2];c[(c[k>>2]|0)+28>>2]=c[p+12>>2];c[p+12>>2]=c[A>>2];c[A>>2]=c[(c[k>>2]|0)+32>>2];c[(c[k>>2]|0)+32>>2]=c[p>>2];c[p>>2]=c[A>>2];c[A>>2]=c[(c[k>>2]|0)+36>>2];c[(c[k>>2]|0)+36>>2]=c[p+16>>2];c[p+16>>2]=c[A>>2];c[(c[k>>2]|0)+40>>2]=2;c[(c[k>>2]|0)+48>>2]=c[p+48>>2];c[p+48>>2]=c[(c[k>>2]|0)+44>>2];c[(c[k>>2]|0)+44>>2]=c[(c[k>>2]|0)+48>>2];c[B>>2]=c[(c[k>>2]|0)+56>>2];c[(c[k>>2]|0)+56>>2]=c[p+44>>2];c[p+44>>2]=c[B>>2];c[(c[k>>2]|0)+52>>2]=c[p+52>>2];c[(c[k>>2]|0)+64>>2]=0;c[(c[k>>2]|0)+76>>2]=0;c[C>>2]=c[(c[k>>2]|0)+88>>2];c[(c[k>>2]|0)+88>>2]=c[p+32>>2];c[p+32>>2]=c[C>>2];c[C>>2]=c[(c[k>>2]|0)+92>>2];c[(c[k>>2]|0)+92>>2]=c[p+36>>2];c[p+36>>2]=c[C>>2];c[(c[k>>2]|0)+104>>2]=0;g[(c[k>>2]|0)+120>>2]=0.0;g[(c[k>>2]|0)+116>>2]=0.0;g[(c[k>>2]|0)+112>>2]=0.0;g[(c[k>>2]|0)+108>>2]=0.0;c[(c[k>>2]|0)+124>>2]=0;c[D>>2]=c[(c[k>>2]|0)+100>>2];c[(c[k>>2]|0)+100>>2]=c[p+40>>2];c[p+40>>2]=c[D>>2];g[(c[k>>2]|0)+132>>2]=+g[p+28>>2];c[(c[k>>2]|0)+144>>2]=0;De(c[k>>2]|0);if((c[(c[k>>2]|0)+96>>2]|0)!=0){Kb[c[(c[(c[k>>2]|0)+8>>2]|0)+148>>2]&7](c[(c[k>>2]|0)+140>>2]|0,c[(c[k>>2]|0)+96>>2]|0)}v=Tb[c[(c[(c[k>>2]|0)+8>>2]|0)+144>>2]&15](c[(c[k>>2]|0)+140>>2]|0,c[(c[(c[k>>2]|0)+56>>2]|0)+(((c[(c[k>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0)|0;c[(c[k>>2]|0)+96>>2]=v;ue(c[k>>2]|0);if((c[(c[k>>2]|0)+164>>2]|0)!=0){Jb[c[(c[k>>2]|0)+164>>2]&7](c[(c[k>>2]|0)+168>>2]|0)}c[u>>2]=0;break}}}while(0);ne(c[t>>2]|0);ne(c[p>>2]|0);ne(c[p+4>>2]|0);ne(c[p+24>>2]|0);ne(c[p+8>>2]|0);ne(c[p+12>>2]|0);ne(c[p+16>>2]|0);ne(c[p+20>>2]|0);if((c[p+32>>2]|0)!=0){Jb[c[(c[(c[k>>2]|0)+8>>2]|0)+32>>2]&7](c[p+32>>2]|0)}if((c[p+36>>2]|0)!=0){Jb[c[(c[(c[k>>2]|0)+8>>2]|0)+32>>2]&7](c[p+36>>2]|0)}if((c[p+40>>2]|0)!=0){Jb[c[(c[(c[k>>2]|0)+8>>2]|0)+100>>2]&7](c[p+40>>2]|0)}if((c[p+44>>2]|0)==0){H=c[u>>2]|0;i=j;return H|0}c[E>>2]=0;while(1){if((c[E>>2]|0)>=(c[p+48>>2]|0)){break}if((c[(c[p+44>>2]|0)+((c[E>>2]|0)*12|0)>>2]|0)!=0){Jb[c[(c[(c[k>>2]|0)+8>>2]|0)+72>>2]&7](c[(c[p+44>>2]|0)+((c[E>>2]|0)*12|0)>>2]|0)}ne(c[(c[p+44>>2]|0)+((c[E>>2]|0)*12|0)+4>>2]|0);c[E>>2]=(c[E>>2]|0)+1}ne(c[p+44>>2]|0);H=c[u>>2]|0;i=j;return H|0}function ff(b){b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;d=i;i=i+48|0;e=d+33|0;f=d+28|0;g=d+24|0;h=d+12|0;j=d+32|0;k=d;c[f>>2]=b;b=c[f>>2]|0;if((c[(c[f>>2]|0)+52>>2]|0)>1){if((c[b+100>>2]|0)!=0){Qb[c[(c[(c[f>>2]|0)+8>>2]|0)+116>>2]&7](c[(c[f>>2]|0)+100>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-2|0)*12|0)>>2]|0)}l=(c[f>>2]|0)+52|0;c[l>>2]=(c[l>>2]|0)+ -1;c[(c[f>>2]|0)+124>>2]=-1;a[e]=1;m=a[e]|0;n=m&1;i=d;return n|0}if((c[b+64>>2]|0)==0){a[e]=0;m=a[e]|0;n=m&1;i=d;return n|0}c[k>>2]=0;c[k+8>>2]=0;c[k+4>>2]=0;Ae(c[f>>2]|0,5,k);c[h>>2]=(c[f>>2]|0)+60;c[h+4>>2]=c[(c[f>>2]|0)+64>>2];c[h+8>>2]=0;a[j]=0;c[g>>2]=ef(c[f>>2]|0,6,h,7,j)|0;if(a[j]&1){ne(c[k>>2]|0);a[e]=0;m=a[e]|0;n=m&1;i=d;return n|0}if((c[g>>2]|0)!=0){Ga(4104,2264,688,4200)}c[(c[f>>2]|0)+64>>2]=0;c[(c[f>>2]|0)+76>>2]=0;Be((c[f>>2]|0)+72|0,c[k>>2]|0,c[k+4>>2]|0);ne(c[k>>2]|0);a[e]=1;m=a[e]|0;n=m&1;i=d;return n|0}function gf(b){b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;d=i;i=i+48|0;e=d+33|0;f=d+28|0;g=d+24|0;h=d+12|0;j=d+32|0;k=d;c[f>>2]=b;b=c[f>>2]|0;if((c[(c[f>>2]|0)+52>>2]|0)<(c[(c[f>>2]|0)+44>>2]|0)){if((c[b+100>>2]|0)!=0){Qb[c[(c[(c[f>>2]|0)+8>>2]|0)+116>>2]&7](c[(c[f>>2]|0)+100>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+(((c[(c[f>>2]|0)+52>>2]|0)-1|0)*12|0)>>2]|0,c[(c[(c[f>>2]|0)+56>>2]|0)+((c[(c[f>>2]|0)+52>>2]|0)*12|0)>>2]|0)}l=(c[f>>2]|0)+52|0;c[l>>2]=(c[l>>2]|0)+1;c[(c[f>>2]|0)+124>>2]=1;a[e]=1;m=a[e]|0;n=m&1;i=d;return n|0}if((c[b+76>>2]|0)==0){a[e]=0;m=a[e]|0;n=m&1;i=d;return n|0}c[k>>2]=0;c[k+8>>2]=0;c[k+4>>2]=0;Ae(c[f>>2]|0,5,k);c[h>>2]=(c[f>>2]|0)+72;c[h+4>>2]=c[(c[f>>2]|0)+76>>2];c[h+8>>2]=0;a[j]=0;c[g>>2]=ef(c[f>>2]|0,6,h,7,j)|0;if(a[j]&1){ne(c[k>>2]|0);a[e]=0;m=a[e]|0;n=m&1;i=d;return n|0}if((c[g>>2]|0)!=0){Ga(4104,2264,761,4128)}c[(c[f>>2]|0)+76>>2]=0;c[(c[f>>2]|0)+64>>2]=0;Be((c[f>>2]|0)+60|0,c[k>>2]|0,c[k+4>>2]|0);ne(c[k>>2]|0);a[e]=1;m=a[e]|0;n=m&1;i=d;return n|0}function hf(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;f=i;i=i+32|0;g=f+16|0;h=f+12|0;j=f+8|0;k=f+4|0;l=f;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=c[h>>2];if((c[k>>2]|0)>((c[(c[l>>2]|0)+4>>2]|0)-(c[(c[l>>2]|0)+8>>2]|0)|0)){a[g]=0;m=a[g]|0;n=m&1;i=f;return n|0}else{bg(c[j>>2]|0,(c[c[c[l>>2]>>2]>>2]|0)+(c[(c[l>>2]|0)+8>>2]|0)|0,c[k>>2]|0)|0;j=(c[l>>2]|0)+8|0;c[j>>2]=(c[j>>2]|0)+(c[k>>2]|0);a[g]=1;m=a[g]|0;n=m&1;i=f;return n|0}return 0}function jf(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;f=i;i=i+32|0;g=f+24|0;h=f+20|0;j=f+16|0;k=f+12|0;l=f+8|0;m=f+4|0;n=f;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=c[h>>2];c[m>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[j>>2]|0)+88>>2]|0,1)|0;c[n>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[k>>2]|0)+32>>2]|0,1)|0;if((Yf(c[m>>2]|0,c[n>>2]|0)|0)!=0){a[c[l>>2]|0]=1;c[g>>2]=4144;o=c[g>>2]|0;i=f;return o|0}c[m>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[j>>2]|0)+92>>2]|0,1)|0;c[n>>2]=Tb[c[(c[(c[j>>2]|0)+8>>2]|0)+28>>2]&15](c[(c[k>>2]|0)+36>>2]|0,1)|0;if((Yf(c[m>>2]|0,c[n>>2]|0)|0)!=0){a[c[l>>2]|0]=1;c[g>>2]=4144;o=c[g>>2]|0;i=f;return o|0}else{c[g>>2]=0;o=c[g>>2]|0;i=f;return o|0}return 0}function kf(a){a=a|0;var b=0,d=0,e=0;b=i;i=i+16|0;d=b+4|0;e=b;c[d>>2]=a;c[e>>2]=c[d>>2];while(1){if((c[(c[e>>2]|0)+4>>2]|0)==3){break}if((c[(c[e>>2]|0)+4>>2]|0)==0){ne(c[(c[e>>2]|0)+8>>2]|0)}c[e>>2]=(c[e>>2]|0)+16}ne(c[d>>2]|0);i=b;return}function lf(b,e,f){b=b|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0;g=i;i=i+384|0;h=g;j=g+264|0;k=g+260|0;l=g+372|0;m=g+256|0;n=g+252|0;o=g+248|0;p=g+216|0;q=g+212|0;r=g+208|0;s=g+112|0;t=g+16|0;u=g+352|0;v=g+272|0;w=g+8|0;x=g+4|0;c[j>>2]=b;c[k>>2]=e;a[l]=f&1;c[m>>2]=((c[k>>2]|0)+7|0)/8|0;c[n>>2]=(c[m>>2]|0)/2|0;c[o>>2]=(c[m>>2]|0)-(c[n>>2]|0);c[p+((a[l]&1?1:0)<<4)>>2]=(c[j>>2]|0)+(c[n>>2]|0);c[p+((a[l]&1?1:0)<<4)+4>>2]=c[o>>2];c[p+((a[l]&1?1:0)<<4)+8>>2]=c[j>>2];c[p+((a[l]&1?1:0)<<4)+12>>2]=c[n>>2];c[p+((a[l]&1?0:1)<<4)>>2]=c[j>>2];c[p+((a[l]&1?0:1)<<4)+4>>2]=c[n>>2];c[p+((a[l]&1?0:1)<<4)+8>>2]=(c[j>>2]|0)+(c[n>>2]|0);c[p+((a[l]&1?0:1)<<4)+12>>2]=c[o>>2];c[q>>2]=0;while(1){if((c[q>>2]|0)>=2){break}c[w>>2]=20;c[x>>2]=0;tf(s);vf(s,c[p+(c[q>>2]<<4)>>2]|0,c[p+(c[q>>2]<<4)+4>>2]|0);c[r>>2]=0;while(1){if((c[r>>2]|0)>=(c[p+(c[q>>2]<<4)+12>>2]|0)){break}if((c[w>>2]|0)>=20){o=c[x>>2]|0;c[x>>2]=o+1;c[h>>2]=o;fb(v|0,4280,h|0)|0;o=t+0|0;l=s+0|0;n=o+96|0;do{c[o>>2]=c[l>>2];o=o+4|0;l=l+4|0}while((o|0)<(n|0));vf(t,v,dg(v|0)|0);xf(t,u);c[w>>2]=0}l=c[w>>2]|0;c[w>>2]=l+1;o=(c[p+(c[q>>2]<<4)+8>>2]|0)+(c[r>>2]|0)|0;a[o]=(d[o]|0)^(d[u+l|0]|0);c[r>>2]=(c[r>>2]|0)+1}if(((c[k>>2]|0)%8|0|0)!=0){l=(c[j>>2]|0)+((c[k>>2]|0)/8|0)|0;a[l]=(d[l]|0)&(255&65280>>((c[k>>2]|0)%8|0))}c[q>>2]=(c[q>>2]|0)+1}i=g;return}function mf(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0;f=i;i=i+32|0;g=f+20|0;h=f+16|0;j=f+12|0;k=f+8|0;l=f+4|0;m=f;c[g>>2]=b;c[h>>2]=e;c[j>>2]=me((c[h>>2]<<1)+1|0)|0;c[k>>2]=c[j>>2];c[l>>2]=0;while(1){if((c[l>>2]|0)>=(c[h>>2]<<1|0)){break}c[m>>2]=d[(c[g>>2]|0)+((c[l>>2]|0)/2|0)|0]|0;if(((c[l>>2]|0)%2|0|0)==0){c[m>>2]=c[m>>2]>>4}e=a[4288+(c[m>>2]&15)|0]|0;b=c[k>>2]|0;c[k>>2]=b+1;a[b]=e;c[l>>2]=(c[l>>2]|0)+1}a[c[k>>2]|0]=0;i=f;return c[j>>2]|0}function nf(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;f=i;i=i+32|0;g=f+20|0;h=f+16|0;j=f+12|0;k=f+8|0;l=f+4|0;m=f;c[g>>2]=b;c[h>>2]=e;c[j>>2]=me(c[h>>2]|0)|0;eg(c[j>>2]|0,0,c[h>>2]|0)|0;c[k>>2]=0;while(1){if((c[k>>2]|0)>=(c[h>>2]<<1|0)){n=13;break}c[l>>2]=a[(c[g>>2]|0)+(c[k>>2]|0)|0]|0;if((c[l>>2]|0)==0){n=4;break}e=c[l>>2]|0;do{if(!((c[l>>2]|0)>=48&(c[l>>2]|0)<=57)){b=c[l>>2]|0;if((e|0)>=97&(c[l>>2]|0)<=102){c[m>>2]=b-97+10;break}if((b|0)>=65&(c[l>>2]|0)<=70){c[m>>2]=(c[l>>2]|0)-65+10;break}else{c[m>>2]=0;break}}else{c[m>>2]=e-48}}while(0);e=(c[j>>2]|0)+((c[k>>2]|0)/2|0)|0;a[e]=d[e]|c[m>>2]<<(1-((c[k>>2]|0)%2|0)<<2);c[k>>2]=(c[k>>2]|0)+1}if((n|0)==4){Ga(4312,4320,166,4328)}else if((n|0)==13){i=f;return c[j>>2]|0}return 0}function of(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var h=0,j=0,k=0,l=0,m=0,n=0,o=0;h=i;i=i+32|0;j=h+20|0;k=h+16|0;l=h+12|0;m=h+8|0;n=h+4|0;o=h;c[h+24>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;g[n>>2]=+g[(c[j>>2]|0)+((c[k>>2]|0)*3<<2)>>2];c[o>>2]=1;while(1){if((c[o>>2]|0)>=3){break}if(+g[(c[j>>2]|0)+(((c[k>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]>+g[n>>2]){g[n>>2]=+g[(c[j>>2]|0)+(((c[k>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]}c[o>>2]=(c[o>>2]|0)+1}a:do{if(+g[n>>2]*1.2000000476837158>1.0){c[o>>2]=0;while(1){if((c[o>>2]|0)>=3){break a}f=(c[j>>2]|0)+(((c[k>>2]|0)*3|0)+(c[o>>2]|0)<<2)|0;g[f>>2]=+g[f>>2]/(+g[n>>2]*1.2000000476837158);c[o>>2]=(c[o>>2]|0)+1}}}while(0);c[o>>2]=0;while(1){if((c[o>>2]|0)>=3){break}if((c[l>>2]|0)>=0){g[(c[j>>2]|0)+(((c[l>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]=+g[(c[j>>2]|0)+(((c[k>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]*1.2000000476837158}if((c[m>>2]|0)>=0){g[(c[j>>2]|0)+(((c[m>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]=+g[(c[j>>2]|0)+(((c[k>>2]|0)*3|0)+(c[o>>2]|0)<<2)>>2]*.800000011920929}c[o>>2]=(c[o>>2]|0)+1}i=h;return}function pf(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0,m=0;g=i;i=i+32|0;h=g+16|0;j=g+12|0;k=g+8|0;l=g+4|0;m=g;c[h>>2]=a;c[j>>2]=b;c[k>>2]=d;c[l>>2]=e;c[m>>2]=f;Ic(c[h>>2]|0,(c[j>>2]|0)+((c[k>>2]|0)*3<<2)|0);of(c[h>>2]|0,c[j>>2]|0,c[k>>2]|0,c[l>>2]|0,c[m>>2]|0);i=g;return}function qf(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;f=i;i=i+32|0;g=f+24|0;h=f+20|0;j=f+16|0;k=f+12|0;l=f+8|0;m=f+4|0;n=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=d;c[k>>2]=e;c[l>>2]=c[g>>2];c[m>>2]=c[h>>2];while(1){h=c[m>>2]|0;c[m>>2]=h+ -1;if((h|0)<=1){break}c[n>>2]=Bf(c[k>>2]|0,(c[m>>2]|0)+1|0)|0;if((c[n>>2]|0)==(c[m>>2]|0)){continue}h=(c[l>>2]|0)+($(c[j>>2]|0,c[m>>2]|0)|0)|0;g=(c[l>>2]|0)+($(c[j>>2]|0,c[n>>2]|0)|0)|0;rf(h,g,c[j>>2]|0)}i=f;return}function rf(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0;e=i;i=i+544|0;f=e+20|0;g=e+16|0;h=e+12|0;j=e+24|0;k=e+8|0;l=e+4|0;m=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;c[k>>2]=c[f>>2];c[l>>2]=c[g>>2];while(1){if((c[h>>2]|0)<=0){break}c[m>>2]=(c[h>>2]|0)>>>0<512?c[h>>2]|0:512;bg(j|0,c[k>>2]|0,c[m>>2]|0)|0;bg(c[k>>2]|0,c[l>>2]|0,c[m>>2]|0)|0;bg(c[l>>2]|0,j|0,c[m>>2]|0)|0;c[k>>2]=(c[k>>2]|0)+(c[m>>2]|0);c[l>>2]=(c[l>>2]|0)+(c[m>>2]|0);c[h>>2]=(c[h>>2]|0)-(c[m>>2]|0)}i=e;return}function sf(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0;f=i;i=i+16|0;g=f+12|0;h=f+8|0;j=f+4|0;k=f;c[g>>2]=b;c[h>>2]=d;c[j>>2]=e;c[k>>2]=dg(c[j>>2]|0)|0;if(!((c[h>>2]|0)>>>0>0)){Ga(4336,4320,398,4344)}eg(c[g>>2]|0,32,(c[h>>2]|0)-1|0)|0;if((c[k>>2]|0)>>>0<=((c[h>>2]|0)-1|0)>>>0){bg(c[g>>2]|0,c[j>>2]|0,c[k>>2]|0)|0;a[(c[g>>2]|0)+((c[h>>2]|0)-1)|0]=0;i=f;return}else{Ga(4368,4320,400,4344)}}function tf(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;uf(c[d>>2]|0);c[(c[d>>2]|0)+84>>2]=0;c[(c[d>>2]|0)+92>>2]=0;c[(c[d>>2]|0)+88>>2]=0;i=b;return}function uf(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;c[c[d>>2]>>2]=1732584193;c[(c[d>>2]|0)+4>>2]=-271733879;c[(c[d>>2]|0)+8>>2]=-1732584194;c[(c[d>>2]|0)+12>>2]=271733878;c[(c[d>>2]|0)+16>>2]=-1009589776;i=b;return}function vf(a,b,e){a=a|0;b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;f=i;i=i+96|0;g=f+84|0;h=f+80|0;j=f+76|0;k=f+72|0;l=f+8|0;m=f+4|0;n=f;c[g>>2]=a;c[h>>2]=b;c[j>>2]=e;c[k>>2]=c[h>>2];c[m>>2]=c[j>>2];h=(c[g>>2]|0)+92|0;c[h>>2]=(c[h>>2]|0)+(c[m>>2]|0);h=(c[g>>2]|0)+88|0;c[h>>2]=(c[h>>2]|0)+((c[(c[g>>2]|0)+92>>2]|0)>>>0<(c[m>>2]|0)>>>0);if((c[(c[g>>2]|0)+84>>2]|0)!=0?((c[(c[g>>2]|0)+84>>2]|0)+(c[j>>2]|0)|0)<64:0){bg((c[g>>2]|0)+20+(c[(c[g>>2]|0)+84>>2]|0)|0,c[k>>2]|0,c[j>>2]|0)|0;m=(c[g>>2]|0)+84|0;c[m>>2]=(c[m>>2]|0)+(c[j>>2]|0);i=f;return}while(1){o=(c[g>>2]|0)+20|0;if(((c[(c[g>>2]|0)+84>>2]|0)+(c[j>>2]|0)|0)<64){break}bg(o+(c[(c[g>>2]|0)+84>>2]|0)|0,c[k>>2]|0,64-(c[(c[g>>2]|0)+84>>2]|0)|0)|0;c[k>>2]=(c[k>>2]|0)+(64-(c[(c[g>>2]|0)+84>>2]|0));c[j>>2]=(c[j>>2]|0)-(64-(c[(c[g>>2]|0)+84>>2]|0));c[n>>2]=0;while(1){if((c[n>>2]|0)>=16){break}c[l+(c[n>>2]<<2)>>2]=(d[(c[g>>2]|0)+20+((c[n>>2]<<2)+0)|0]|0)<<24|(d[(c[g>>2]|0)+20+((c[n>>2]<<2)+1)|0]|0)<<16|(d[(c[g>>2]|0)+20+((c[n>>2]<<2)+2)|0]|0)<<8|(d[(c[g>>2]|0)+20+((c[n>>2]<<2)+3)|0]|0)<<0;c[n>>2]=(c[n>>2]|0)+1}wf(c[g>>2]|0,l);c[(c[g>>2]|0)+84>>2]=0}bg(o|0,c[k>>2]|0,c[j>>2]|0)|0;c[(c[g>>2]|0)+84>>2]=c[j>>2];i=f;return}function wf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0;d=i;i=i+384|0;e=d+372|0;f=d+368|0;g=d+48|0;h=d+40|0;j=d+36|0;k=d+32|0;l=d+28|0;m=d+24|0;n=d+20|0;o=d+16|0;p=d+12|0;q=d+8|0;r=d+4|0;s=d;c[e>>2]=a;c[f>>2]=b;c[n>>2]=0;while(1){if((c[n>>2]|0)>=16){break}c[g+(c[n>>2]<<2)>>2]=c[(c[f>>2]|0)+(c[n>>2]<<2)>>2];c[n>>2]=(c[n>>2]|0)+1}c[n>>2]=16;while(1){if((c[n>>2]|0)>=80){break}c[o>>2]=c[g+((c[n>>2]|0)-3<<2)>>2]^c[g+((c[n>>2]|0)-8<<2)>>2]^c[g+((c[n>>2]|0)-14<<2)>>2]^c[g+((c[n>>2]|0)-16<<2)>>2];c[g+(c[n>>2]<<2)>>2]=c[o>>2]<<1|(c[o>>2]|0)>>>31;c[n>>2]=(c[n>>2]|0)+1}c[h>>2]=c[c[e>>2]>>2];c[j>>2]=c[(c[e>>2]|0)+4>>2];c[k>>2]=c[(c[e>>2]|0)+8>>2];c[l>>2]=c[(c[e>>2]|0)+12>>2];c[m>>2]=c[(c[e>>2]|0)+16>>2];c[n>>2]=0;while(1){if((c[n>>2]|0)>=20){break}c[p>>2]=(c[h>>2]<<5|(c[h>>2]|0)>>>27)+(c[j>>2]&c[k>>2]|c[l>>2]&~c[j>>2])+(c[m>>2]|0)+(c[g+(c[n>>2]<<2)>>2]|0)+1518500249;c[m>>2]=c[l>>2];c[l>>2]=c[k>>2];c[k>>2]=c[j>>2]<<30|(c[j>>2]|0)>>>2;c[j>>2]=c[h>>2];c[h>>2]=c[p>>2];c[n>>2]=(c[n>>2]|0)+1}c[n>>2]=20;while(1){if((c[n>>2]|0)>=40){break}c[q>>2]=(c[h>>2]<<5|(c[h>>2]|0)>>>27)+(c[j>>2]^c[k>>2]^c[l>>2])+(c[m>>2]|0)+(c[g+(c[n>>2]<<2)>>2]|0)+1859775393;c[m>>2]=c[l>>2];c[l>>2]=c[k>>2];c[k>>2]=c[j>>2]<<30|(c[j>>2]|0)>>>2;c[j>>2]=c[h>>2];c[h>>2]=c[q>>2];c[n>>2]=(c[n>>2]|0)+1}c[n>>2]=40;while(1){if((c[n>>2]|0)>=60){break}c[r>>2]=(c[h>>2]<<5|(c[h>>2]|0)>>>27)+(c[j>>2]&c[k>>2]|c[j>>2]&c[l>>2]|c[k>>2]&c[l>>2])+(c[m>>2]|0)+(c[g+(c[n>>2]<<2)>>2]|0)+ -1894007588;c[m>>2]=c[l>>2];c[l>>2]=c[k>>2];c[k>>2]=c[j>>2]<<30|(c[j>>2]|0)>>>2;c[j>>2]=c[h>>2];c[h>>2]=c[r>>2];c[n>>2]=(c[n>>2]|0)+1}c[n>>2]=60;while(1){t=c[h>>2]|0;if((c[n>>2]|0)>=80){break}c[s>>2]=(t<<5|(c[h>>2]|0)>>>27)+(c[j>>2]^c[k>>2]^c[l>>2])+(c[m>>2]|0)+(c[g+(c[n>>2]<<2)>>2]|0)+ -899497514;c[m>>2]=c[l>>2];c[l>>2]=c[k>>2];c[k>>2]=c[j>>2]<<30|(c[j>>2]|0)>>>2;c[j>>2]=c[h>>2];c[h>>2]=c[s>>2];c[n>>2]=(c[n>>2]|0)+1}n=c[e>>2]|0;c[n>>2]=(c[n>>2]|0)+t;t=(c[e>>2]|0)+4|0;c[t>>2]=(c[t>>2]|0)+(c[j>>2]|0);j=(c[e>>2]|0)+8|0;c[j>>2]=(c[j>>2]|0)+(c[k>>2]|0);k=(c[e>>2]|0)+12|0;c[k>>2]=(c[k>>2]|0)+(c[l>>2]|0);l=(c[e>>2]|0)+16|0;c[l>>2]=(c[l>>2]|0)+(c[m>>2]|0);i=d;return}function xf(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0;e=i;i=i+96|0;f=e+20|0;g=e+16|0;h=e+12|0;j=e+8|0;k=e+24|0;l=e+4|0;m=e;c[f>>2]=b;c[g>>2]=d;d=c[(c[f>>2]|0)+84>>2]|0;if((c[(c[f>>2]|0)+84>>2]|0)>=56){c[j>>2]=120-d}else{c[j>>2]=56-d}c[l>>2]=c[(c[f>>2]|0)+88>>2]<<3|(c[(c[f>>2]|0)+92>>2]|0)>>>29;c[m>>2]=c[(c[f>>2]|0)+92>>2]<<3;eg(k|0,0,c[j>>2]|0)|0;a[k]=-128;vf(c[f>>2]|0,k,c[j>>2]|0);a[k]=(c[l>>2]|0)>>>24&255;a[k+1|0]=(c[l>>2]|0)>>>16&255;a[k+2|0]=(c[l>>2]|0)>>>8&255;a[k+3|0]=(c[l>>2]|0)>>>0&255;a[k+4|0]=(c[m>>2]|0)>>>24&255;a[k+5|0]=(c[m>>2]|0)>>>16&255;a[k+6|0]=(c[m>>2]|0)>>>8&255;a[k+7|0]=(c[m>>2]|0)>>>0&255;vf(c[f>>2]|0,k,8);c[h>>2]=0;while(1){if((c[h>>2]|0)>=5){break}a[(c[g>>2]|0)+(c[h>>2]<<2)|0]=(c[(c[f>>2]|0)+(c[h>>2]<<2)>>2]|0)>>>24&255;a[(c[g>>2]|0)+((c[h>>2]<<2)+1)|0]=(c[(c[f>>2]|0)+(c[h>>2]<<2)>>2]|0)>>>16&255;a[(c[g>>2]|0)+((c[h>>2]<<2)+2)|0]=(c[(c[f>>2]|0)+(c[h>>2]<<2)>>2]|0)>>>8&255;a[(c[g>>2]|0)+((c[h>>2]<<2)+3)|0]=c[(c[f>>2]|0)+(c[h>>2]<<2)>>2]&255;c[h>>2]=(c[h>>2]|0)+1}i=e;return}function yf(a,b,d){a=a|0;b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0;e=i;i=i+112|0;f=e+104|0;g=e+100|0;h=e+96|0;j=e;c[f>>2]=a;c[g>>2]=b;c[h>>2]=d;tf(j);vf(j,c[f>>2]|0,c[g>>2]|0);xf(j,c[h>>2]|0);i=e;return}function zf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;i=i+16|0;e=d+8|0;f=d+4|0;g=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=me(64)|0;yf(c[e>>2]|0,c[f>>2]|0,c[g>>2]|0);yf(c[g>>2]|0,20,(c[g>>2]|0)+20|0);yf(c[g>>2]|0,40,(c[g>>2]|0)+40|0);c[(c[g>>2]|0)+60>>2]=0;i=d;return c[g>>2]|0}function Af(b,e){b=b|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;f=i;i=i+32|0;g=f+16|0;h=f+12|0;j=f+8|0;k=f+4|0;l=f;c[g>>2]=b;c[h>>2]=e;c[j>>2]=0;c[k>>2]=0;while(1){if((c[k>>2]|0)>=(c[h>>2]|0)){break}if((c[(c[g>>2]|0)+60>>2]|0)>=20){c[l>>2]=0;while(1){if((c[l>>2]|0)>=20){break}m=(c[g>>2]|0)+(c[l>>2]|0)|0;if((d[(c[g>>2]|0)+(c[l>>2]|0)|0]|0|0)!=255){n=7;break}a[m]=0;c[l>>2]=(c[l>>2]|0)+1}if((n|0)==7){n=0;a[m]=(a[m]|0)+1<<24>>24}yf(c[g>>2]|0,40,(c[g>>2]|0)+40|0);c[(c[g>>2]|0)+60>>2]=0}e=c[j>>2]<<8;b=(c[g>>2]|0)+60|0;o=c[b>>2]|0;c[b>>2]=o+1;c[j>>2]=e|(d[(c[g>>2]|0)+40+o|0]|0);c[k>>2]=(c[k>>2]|0)+8}c[j>>2]=c[j>>2]&(1<<(c[h>>2]|0)-1<<1)-1;i=f;return c[j>>2]|0}function Bf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0;d=i;i=i+32|0;e=d+20|0;f=d+16|0;g=d+12|0;h=d+8|0;j=d+4|0;k=d;c[e>>2]=a;c[f>>2]=b;c[g>>2]=0;while(1){l=c[g>>2]|0;if(((c[f>>2]|0)>>>(c[g>>2]|0)|0)==0){break}c[g>>2]=l+1}c[g>>2]=l+3;if((c[g>>2]|0)>=32){Ga(4384,4400,275,4416)}c[h>>2]=1<<c[g>>2];c[j>>2]=((c[h>>2]|0)>>>0)/((c[f>>2]|0)>>>0)|0;c[h>>2]=$(c[f>>2]|0,c[j>>2]|0)|0;do{c[k>>2]=Af(c[e>>2]|0,c[g>>2]|0)|0}while((c[k>>2]|0)>>>0>=(c[h>>2]|0)>>>0);i=d;return((c[k>>2]|0)>>>0)/((c[j>>2]|0)>>>0)|0|0}function Cf(a){a=a|0;var b=0,d=0;b=i;i=i+16|0;d=b;c[d>>2]=a;ne(c[d>>2]|0);i=b;return}function Df(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,aa=0,ba=0,ca=0,da=0,ea=0,fa=0,ga=0;f=i;i=i+944|0;g=f+680|0;h=f+424|0;j=f+192|0;k=f;l=$(d,b)|0;if((l|0)==0){i=f;return}b=l-d|0;c[k+4>>2]=d;c[k>>2]=d;m=d;n=d;o=2;while(1){p=m+d+n|0;c[k+(o<<2)>>2]=p;if(p>>>0<l>>>0){q=n;n=p;o=o+1|0;m=q}else{break}}m=0-d|0;o=a+b|0;if((b|0)>0){b=(d|0)==0;n=d>>>0>256?256:d;l=(n|0)==(d|0);q=o;p=1;r=0;s=a;t=1;while(1){do{if((p&3|0)!=3){u=t+ -1|0;a:do{if((c[k+(u<<2)>>2]|0)>>>0<(q-s|0)>>>0){c[j>>2]=s;if((t|0)>1){v=t;w=s;x=s;y=1;while(1){z=w+m|0;A=v+ -2|0;B=w+(0-((c[k+(A<<2)>>2]|0)+d))|0;if((Tb[e&15](x,B)|0)>-1?(Tb[e&15](x,z)|0)>-1:0){C=y;break}D=y+1|0;E=j+(y<<2)|0;if((Tb[e&15](B,z)|0)>-1){c[E>>2]=B;F=B;G=v+ -1|0}else{c[E>>2]=z;F=z;G=A}if((G|0)<=1){C=D;break}v=G;w=F;x=c[j>>2]|0;y=D}if((C|0)>=2?(y=j+(C<<2)|0,c[y>>2]=g,!b):0){if((C|0)>0){H=d;I=g}else{x=c[j>>2]|0;bg(g|0,x|0,n|0)|0;if(l){break}else{J=d;K=n}while(1){J=J-K|0;K=J>>>0>256?256:J;bg(g|0,x|0,K|0)|0;if((J|0)==(K|0)){break a}}}while(1){x=H>>>0>256?256:H;w=c[j>>2]|0;bg(I|0,w|0,x|0)|0;v=w;w=0;do{D=w;w=w+1|0;A=v;v=c[j+(w<<2)>>2]|0;bg(A|0,v|0,x|0)|0;c[j+(D<<2)>>2]=A+x}while((w|0)!=(C|0));if((H|0)==(x|0)){break a}H=H-x|0;I=c[y>>2]|0}}}}else{Ef(s,d,e,p,r,t,0,k)}}while(0);if((t|0)==1){L=p<<1;M=p>>>31|r<<1;N=0;break}else{y=u>>>0>31;w=y?0:p;v=y?t+ -33|0:u;L=w<<v;M=w>>>(32-v|0)|(y?p:r)<<v;N=1;break}}else{c[j>>2]=s;b:do{if((t|0)>1){v=t;y=s;w=s;A=1;while(1){D=y+m|0;z=v+ -2|0;E=y+(0-((c[k+(z<<2)>>2]|0)+d))|0;if((Tb[e&15](w,E)|0)>-1?(Tb[e&15](w,D)|0)>-1:0){O=A;break}B=A+1|0;P=j+(A<<2)|0;if((Tb[e&15](E,D)|0)>-1){c[P>>2]=E;Q=E;R=v+ -1|0}else{c[P>>2]=D;Q=D;R=z}if((R|0)<=1){O=B;break}v=R;y=Q;w=c[j>>2]|0;A=B}if((O|0)>=2?(A=j+(O<<2)|0,c[A>>2]=h,!b):0){if((O|0)>0){S=d;T=h}else{w=c[j>>2]|0;bg(h|0,w|0,n|0)|0;if(l){break}else{U=d;V=n}while(1){U=U-V|0;V=U>>>0>256?256:U;bg(h|0,w|0,V|0)|0;if((U|0)==(V|0)){break b}}}while(1){w=S>>>0>256?256:S;y=c[j>>2]|0;bg(T|0,y|0,w|0)|0;v=y;y=0;do{B=y;y=y+1|0;z=v;v=c[j+(y<<2)>>2]|0;bg(z|0,v|0,w|0)|0;c[j+(B<<2)>>2]=z+w}while((y|0)!=(O|0));if((S|0)==(w|0)){break b}S=S-w|0;T=c[A>>2]|0}}}}while(0);L=p>>>2|r<<30;M=r>>>2;N=t+2|0}}while(0);u=L|1;A=s+d|0;if(A>>>0<o>>>0){p=u;r=M;s=A;t=N}else{W=M;X=u;Y=A;Z=N;break}}}else{W=0;X=1;Y=a;Z=1}Ef(Y,d,e,X,W,Z,0,k);a=X;X=W;W=Y;Y=Z;while(1){if((Y|0)==1){if((a|0)==1){if((X|0)==0){break}else{_=52}}}else{_=52}if((_|0)==52?(_=0,(Y|0)>=2):0){Z=a>>>30;N=Y+ -2|0;M=(a<<1&2147483646|Z<<31)^3;t=(Z|X<<2)>>>1;Ef(W+(0-((c[k+(N<<2)>>2]|0)+d))|0,d,e,M,t,Y+ -1|0,1,k);s=t<<1|Z&1;Z=M<<1|1;M=W+m|0;Ef(M,d,e,Z,s,N,1,k);a=Z;X=s;W=M;Y=N;continue}N=a+ -1|0;if((N|0)!=0){if((N&1|0)==0){M=N;N=0;do{N=N+1|0;M=M>>>1}while((M&1|0)==0);if((N|0)!=0){aa=N}else{_=57}}else{_=57}if((_|0)==57){_=0;if((X|0)!=0){if((X&1|0)==0){M=X;s=0;while(1){Z=s+1|0;t=M>>>1;if((t&1|0)==0){M=t;s=Z}else{ba=Z;break}}}else{ba=0}}else{ba=32}aa=(ba|0)==0?0:ba+32|0}if(aa>>>0>31){ca=aa;_=62}else{da=aa;ea=a;fa=X;ga=aa}}else{ca=32;_=62}if((_|0)==62){_=0;da=ca+ -32|0;ea=X;fa=0;ga=ca}a=fa<<32-da|ea>>>da;X=fa>>>da;W=W+m|0;Y=ga+Y|0}i=f;return}function Ef(a,b,d,e,f,g,h,j){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;j=j|0;var k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,$=0,aa=0,ba=0;k=i;i=i+752|0;l=k+232|0;m=k+488|0;n=k;c[n>>2]=a;o=0-b|0;a:do{if((e|0)==1&(f|0)==0){p=a;q=g;r=h;s=1;t=18}else{u=g;v=a;w=h;x=e;y=f;z=a;A=1;while(1){B=v+(0-(c[j+(u<<2)>>2]|0))|0;if((Tb[d&15](B,z)|0)<1){p=v;q=u;r=w;s=A;t=18;break a}if((w|0)==0&(u|0)>1){C=c[j+(u+ -2<<2)>>2]|0;if((Tb[d&15](v+o|0,B)|0)>-1){D=v;E=u;F=A;break a}if((Tb[d&15](v+(0-(C+b))|0,B)|0)>-1){D=v;E=u;F=A;break a}}C=A+1|0;c[n+(A<<2)>>2]=B;G=x+ -1|0;if((G|0)!=0){if((G&1|0)==0){H=G;G=0;do{G=G+1|0;H=H>>>1}while((H&1|0)==0);if((G|0)!=0){I=G}else{t=10}}else{t=10}if((t|0)==10){t=0;if((y|0)!=0){if((y&1|0)==0){H=y;J=0;while(1){K=J+1|0;L=H>>>1;if((L&1|0)==0){H=L;J=K}else{M=K;break}}}else{M=0}}else{M=32}I=(M|0)==0?0:M+32|0}if(I>>>0>31){N=I;t=15}else{O=I;P=x;Q=y;R=I}}else{N=32;t=15}if((t|0)==15){t=0;O=N+ -32|0;P=y;Q=0;R=N}J=Q<<32-O|P>>>O;H=Q>>>O;G=R+u|0;if((J|0)==1&(H|0)==0){D=B;E=G;F=C;break a}u=G;v=B;w=0;x=J;y=H;z=c[n>>2]|0;A=C}}}while(0);if((t|0)==18){if((r|0)==0){D=p;E=q;F=s}else{i=k;return}}b:do{if((F|0)>=2?(s=n+(F<<2)|0,c[s>>2]=l,(b|0)!=0):0){if((F|0)>0){S=b;T=l}else{q=b>>>0>256?256:b;p=c[n>>2]|0;bg(l|0,p|0,q|0)|0;if((q|0)==(b|0)){break}else{U=b;V=q}while(1){U=U-V|0;V=U>>>0>256?256:U;bg(l|0,p|0,V|0)|0;if((U|0)==(V|0)){break b}}}while(1){p=S>>>0>256?256:S;q=c[n>>2]|0;bg(T|0,q|0,p|0)|0;r=q;q=0;do{t=q;q=q+1|0;R=r;r=c[n+(q<<2)>>2]|0;bg(R|0,r|0,p|0)|0;c[n+(t<<2)>>2]=R+p}while((q|0)!=(F|0));if((S|0)==(p|0)){break b}S=S-p|0;T=c[s>>2]|0}}}while(0);c[l>>2]=D;c:do{if((E|0)>1){T=E;S=D;F=D;n=1;while(1){V=S+o|0;U=T+ -2|0;s=S+(0-((c[j+(U<<2)>>2]|0)+b))|0;if((Tb[d&15](F,s)|0)>-1?(Tb[d&15](F,V)|0)>-1:0){W=n;break}q=n+1|0;r=l+(n<<2)|0;if((Tb[d&15](s,V)|0)>-1){c[r>>2]=s;X=s;Y=T+ -1|0}else{c[r>>2]=V;X=V;Y=U}if((Y|0)<=1){W=q;break}T=Y;S=X;F=c[l>>2]|0;n=q}if((W|0)>=2?(n=l+(W<<2)|0,c[n>>2]=m,(b|0)!=0):0){if((W|0)>0){Z=b;_=m}else{F=b>>>0>256?256:b;S=c[l>>2]|0;bg(m|0,S|0,F|0)|0;if((F|0)==(b|0)){$=m;break}else{aa=b;ba=F}while(1){F=aa-ba|0;T=F>>>0>256?256:F;bg(m|0,S|0,T|0)|0;if((F|0)==(T|0)){$=m;break c}else{aa=F;ba=T}}}while(1){S=Z>>>0>256?256:Z;T=c[l>>2]|0;bg(_|0,T|0,S|0)|0;F=T;T=0;do{q=T;T=T+1|0;U=F;F=c[l+(T<<2)>>2]|0;bg(U|0,F|0,S|0)|0;c[l+(q<<2)>>2]=U+S}while((T|0)!=(W|0));if((Z|0)==(S|0)){$=m;break c}Z=Z-S|0;_=c[n>>2]|0}}else{$=m}}else{$=m}}while(0);i=k;return}function Ff(b,c){b=b|0;c=c|0;var d=0,e=0;d=i;e=Gf(b,c)|0;i=d;return((a[e]|0)==(c&255)<<24>>24?e:0)|0}function Gf(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0;e=i;f=d&255;if((f|0)==0){g=b+(dg(b|0)|0)|0;i=e;return g|0}a:do{if((b&3|0)!=0){h=d&255;j=b;while(1){k=a[j]|0;if(k<<24>>24==0){g=j;l=13;break}m=j+1|0;if(k<<24>>24==h<<24>>24){g=j;l=13;break}if((m&3|0)==0){n=m;break a}else{j=m}}if((l|0)==13){i=e;return g|0}}else{n=b}}while(0);b=$(f,16843009)|0;f=c[n>>2]|0;b:do{if(((f&-2139062144^-2139062144)&f+ -16843009|0)==0){l=f;j=n;while(1){h=l^b;m=j+4|0;if(((h&-2139062144^-2139062144)&h+ -16843009|0)!=0){o=j;break b}h=c[m>>2]|0;if(((h&-2139062144^-2139062144)&h+ -16843009|0)==0){l=h;j=m}else{o=m;break}}}else{o=n}}while(0);n=d&255;d=o;while(1){o=a[d]|0;if(o<<24>>24==0|o<<24>>24==n<<24>>24){g=d;break}else{d=d+1|0}}i=e;return g|0}function Hf(b,d){b=b|0;d=d|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;e=i;i=i+32|0;f=e;g=a[d]|0;if(!(g<<24>>24==0)?(a[d+1|0]|0)!=0:0){c[f+0>>2]=0;c[f+4>>2]=0;c[f+8>>2]=0;c[f+12>>2]=0;c[f+16>>2]=0;c[f+20>>2]=0;c[f+24>>2]=0;c[f+28>>2]=0;h=d;d=g;do{j=d&255;k=f+(j>>>5<<2)|0;c[k>>2]=c[k>>2]|1<<(j&31);h=h+1|0;d=a[h]|0}while(!(d<<24>>24==0));d=a[b]|0;a:do{if(d<<24>>24==0){l=b}else{h=b;j=d;while(1){k=j&255;m=h+1|0;if((c[f+(k>>>5<<2)>>2]&1<<(k&31)|0)!=0){l=h;break a}k=a[m]|0;if(k<<24>>24==0){l=m;break}else{h=m;j=k}}}}while(0);n=l-b|0;i=e;return n|0}n=(Gf(b,g<<24>>24)|0)-b|0;i=e;return n|0}function If(a){a=a|0;var b=0,d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,O=0,P=0,Q=0,R=0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,$=0,aa=0,ba=0,ca=0,da=0,ea=0,fa=0,ga=0,ha=0,ia=0,ja=0,ka=0,la=0,ma=0,na=0,oa=0,pa=0,qa=0,ra=0,sa=0,ta=0,ua=0,va=0,wa=0,xa=0,ya=0,za=0,Aa=0,Ba=0,Ca=0,Da=0,Ea=0,Fa=0,Ga=0,Ha=0,Ia=0,Ja=0,Ka=0;b=i;do{if(a>>>0<245){if(a>>>0<11){d=16}else{d=a+11&-8}e=d>>>3;f=c[1108]|0;g=f>>>e;if((g&3|0)!=0){h=(g&1^1)+e|0;j=h<<1;k=4472+(j<<2)|0;l=4472+(j+2<<2)|0;j=c[l>>2]|0;m=j+8|0;n=c[m>>2]|0;do{if((k|0)!=(n|0)){if(n>>>0<(c[4448>>2]|0)>>>0){sb()}o=n+12|0;if((c[o>>2]|0)==(j|0)){c[o>>2]=k;c[l>>2]=n;break}else{sb()}}else{c[1108]=f&~(1<<h)}}while(0);n=h<<3;c[j+4>>2]=n|3;l=j+(n|4)|0;c[l>>2]=c[l>>2]|1;p=m;i=b;return p|0}if(d>>>0>(c[4440>>2]|0)>>>0){if((g|0)!=0){l=2<<e;n=g<<e&(l|0-l);l=(n&0-n)+ -1|0;n=l>>>12&16;k=l>>>n;l=k>>>5&8;o=k>>>l;k=o>>>2&4;q=o>>>k;o=q>>>1&2;r=q>>>o;q=r>>>1&1;s=(l|n|k|o|q)+(r>>>q)|0;q=s<<1;r=4472+(q<<2)|0;o=4472+(q+2<<2)|0;q=c[o>>2]|0;k=q+8|0;n=c[k>>2]|0;do{if((r|0)!=(n|0)){if(n>>>0<(c[4448>>2]|0)>>>0){sb()}l=n+12|0;if((c[l>>2]|0)==(q|0)){c[l>>2]=r;c[o>>2]=n;break}else{sb()}}else{c[1108]=f&~(1<<s)}}while(0);f=s<<3;n=f-d|0;c[q+4>>2]=d|3;o=q+d|0;c[q+(d|4)>>2]=n|1;c[q+f>>2]=n;f=c[4440>>2]|0;if((f|0)!=0){r=c[4452>>2]|0;e=f>>>3;f=e<<1;g=4472+(f<<2)|0;m=c[1108]|0;j=1<<e;if((m&j|0)!=0){e=4472+(f+2<<2)|0;h=c[e>>2]|0;if(h>>>0<(c[4448>>2]|0)>>>0){sb()}else{t=e;u=h}}else{c[1108]=m|j;t=4472+(f+2<<2)|0;u=g}c[t>>2]=r;c[u+12>>2]=r;c[r+8>>2]=u;c[r+12>>2]=g}c[4440>>2]=n;c[4452>>2]=o;p=k;i=b;return p|0}o=c[4436>>2]|0;if((o|0)!=0){n=(o&0-o)+ -1|0;o=n>>>12&16;g=n>>>o;n=g>>>5&8;r=g>>>n;g=r>>>2&4;f=r>>>g;r=f>>>1&2;j=f>>>r;f=j>>>1&1;m=c[4736+((n|o|g|r|f)+(j>>>f)<<2)>>2]|0;f=(c[m+4>>2]&-8)-d|0;j=m;r=m;while(1){m=c[j+16>>2]|0;if((m|0)==0){g=c[j+20>>2]|0;if((g|0)==0){break}else{v=g}}else{v=m}m=(c[v+4>>2]&-8)-d|0;g=m>>>0<f>>>0;f=g?m:f;j=v;r=g?v:r}j=c[4448>>2]|0;if(r>>>0<j>>>0){sb()}k=r+d|0;if(!(r>>>0<k>>>0)){sb()}q=c[r+24>>2]|0;s=c[r+12>>2]|0;do{if((s|0)==(r|0)){g=r+20|0;m=c[g>>2]|0;if((m|0)==0){o=r+16|0;n=c[o>>2]|0;if((n|0)==0){w=0;break}else{x=n;y=o}}else{x=m;y=g}while(1){g=x+20|0;m=c[g>>2]|0;if((m|0)!=0){x=m;y=g;continue}g=x+16|0;m=c[g>>2]|0;if((m|0)==0){break}else{x=m;y=g}}if(y>>>0<j>>>0){sb()}else{c[y>>2]=0;w=x;break}}else{g=c[r+8>>2]|0;if(g>>>0<j>>>0){sb()}m=g+12|0;if((c[m>>2]|0)!=(r|0)){sb()}o=s+8|0;if((c[o>>2]|0)==(r|0)){c[m>>2]=s;c[o>>2]=g;w=s;break}else{sb()}}}while(0);do{if((q|0)!=0){s=c[r+28>>2]|0;j=4736+(s<<2)|0;if((r|0)==(c[j>>2]|0)){c[j>>2]=w;if((w|0)==0){c[4436>>2]=c[4436>>2]&~(1<<s);break}}else{if(q>>>0<(c[4448>>2]|0)>>>0){sb()}s=q+16|0;if((c[s>>2]|0)==(r|0)){c[s>>2]=w}else{c[q+20>>2]=w}if((w|0)==0){break}}if(w>>>0<(c[4448>>2]|0)>>>0){sb()}c[w+24>>2]=q;s=c[r+16>>2]|0;do{if((s|0)!=0){if(s>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[w+16>>2]=s;c[s+24>>2]=w;break}}}while(0);s=c[r+20>>2]|0;if((s|0)!=0){if(s>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[w+20>>2]=s;c[s+24>>2]=w;break}}}}while(0);if(f>>>0<16){q=f+d|0;c[r+4>>2]=q|3;s=r+(q+4)|0;c[s>>2]=c[s>>2]|1}else{c[r+4>>2]=d|3;c[r+(d|4)>>2]=f|1;c[r+(f+d)>>2]=f;s=c[4440>>2]|0;if((s|0)!=0){q=c[4452>>2]|0;j=s>>>3;s=j<<1;g=4472+(s<<2)|0;o=c[1108]|0;m=1<<j;if((o&m|0)!=0){j=4472+(s+2<<2)|0;n=c[j>>2]|0;if(n>>>0<(c[4448>>2]|0)>>>0){sb()}else{z=j;A=n}}else{c[1108]=o|m;z=4472+(s+2<<2)|0;A=g}c[z>>2]=q;c[A+12>>2]=q;c[q+8>>2]=A;c[q+12>>2]=g}c[4440>>2]=f;c[4452>>2]=k}p=r+8|0;i=b;return p|0}else{B=d}}else{B=d}}else{if(!(a>>>0>4294967231)){g=a+11|0;q=g&-8;s=c[4436>>2]|0;if((s|0)!=0){m=0-q|0;o=g>>>8;if((o|0)!=0){if(q>>>0>16777215){C=31}else{g=(o+1048320|0)>>>16&8;n=o<<g;o=(n+520192|0)>>>16&4;j=n<<o;n=(j+245760|0)>>>16&2;h=14-(o|g|n)+(j<<n>>>15)|0;C=q>>>(h+7|0)&1|h<<1}}else{C=0}h=c[4736+(C<<2)>>2]|0;a:do{if((h|0)==0){D=m;E=0;F=0}else{if((C|0)==31){G=0}else{G=25-(C>>>1)|0}n=m;j=0;g=q<<G;o=h;e=0;while(1){l=c[o+4>>2]&-8;H=l-q|0;if(H>>>0<n>>>0){if((l|0)==(q|0)){D=H;E=o;F=o;break a}else{I=H;J=o}}else{I=n;J=e}H=c[o+20>>2]|0;l=c[o+(g>>>31<<2)+16>>2]|0;K=(H|0)==0|(H|0)==(l|0)?j:H;if((l|0)==0){D=I;E=K;F=J;break}else{n=I;j=K;g=g<<1;o=l;e=J}}}}while(0);if((E|0)==0&(F|0)==0){h=2<<C;m=s&(h|0-h);if((m|0)==0){B=q;break}h=(m&0-m)+ -1|0;m=h>>>12&16;r=h>>>m;h=r>>>5&8;k=r>>>h;r=k>>>2&4;f=k>>>r;k=f>>>1&2;e=f>>>k;f=e>>>1&1;L=c[4736+((h|m|r|k|f)+(e>>>f)<<2)>>2]|0}else{L=E}if((L|0)==0){M=D;N=F}else{f=D;e=L;k=F;while(1){r=(c[e+4>>2]&-8)-q|0;m=r>>>0<f>>>0;h=m?r:f;r=m?e:k;m=c[e+16>>2]|0;if((m|0)!=0){f=h;e=m;k=r;continue}m=c[e+20>>2]|0;if((m|0)==0){M=h;N=r;break}else{f=h;e=m;k=r}}}if((N|0)!=0?M>>>0<((c[4440>>2]|0)-q|0)>>>0:0){k=c[4448>>2]|0;if(N>>>0<k>>>0){sb()}e=N+q|0;if(!(N>>>0<e>>>0)){sb()}f=c[N+24>>2]|0;s=c[N+12>>2]|0;do{if((s|0)==(N|0)){r=N+20|0;m=c[r>>2]|0;if((m|0)==0){h=N+16|0;o=c[h>>2]|0;if((o|0)==0){O=0;break}else{P=o;Q=h}}else{P=m;Q=r}while(1){r=P+20|0;m=c[r>>2]|0;if((m|0)!=0){P=m;Q=r;continue}r=P+16|0;m=c[r>>2]|0;if((m|0)==0){break}else{P=m;Q=r}}if(Q>>>0<k>>>0){sb()}else{c[Q>>2]=0;O=P;break}}else{r=c[N+8>>2]|0;if(r>>>0<k>>>0){sb()}m=r+12|0;if((c[m>>2]|0)!=(N|0)){sb()}h=s+8|0;if((c[h>>2]|0)==(N|0)){c[m>>2]=s;c[h>>2]=r;O=s;break}else{sb()}}}while(0);do{if((f|0)!=0){s=c[N+28>>2]|0;k=4736+(s<<2)|0;if((N|0)==(c[k>>2]|0)){c[k>>2]=O;if((O|0)==0){c[4436>>2]=c[4436>>2]&~(1<<s);break}}else{if(f>>>0<(c[4448>>2]|0)>>>0){sb()}s=f+16|0;if((c[s>>2]|0)==(N|0)){c[s>>2]=O}else{c[f+20>>2]=O}if((O|0)==0){break}}if(O>>>0<(c[4448>>2]|0)>>>0){sb()}c[O+24>>2]=f;s=c[N+16>>2]|0;do{if((s|0)!=0){if(s>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[O+16>>2]=s;c[s+24>>2]=O;break}}}while(0);s=c[N+20>>2]|0;if((s|0)!=0){if(s>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[O+20>>2]=s;c[s+24>>2]=O;break}}}}while(0);b:do{if(!(M>>>0<16)){c[N+4>>2]=q|3;c[N+(q|4)>>2]=M|1;c[N+(M+q)>>2]=M;f=M>>>3;if(M>>>0<256){s=f<<1;k=4472+(s<<2)|0;r=c[1108]|0;h=1<<f;if((r&h|0)!=0){f=4472+(s+2<<2)|0;m=c[f>>2]|0;if(m>>>0<(c[4448>>2]|0)>>>0){sb()}else{R=f;S=m}}else{c[1108]=r|h;R=4472+(s+2<<2)|0;S=k}c[R>>2]=e;c[S+12>>2]=e;c[N+(q+8)>>2]=S;c[N+(q+12)>>2]=k;break}k=M>>>8;if((k|0)!=0){if(M>>>0>16777215){T=31}else{s=(k+1048320|0)>>>16&8;h=k<<s;k=(h+520192|0)>>>16&4;r=h<<k;h=(r+245760|0)>>>16&2;m=14-(k|s|h)+(r<<h>>>15)|0;T=M>>>(m+7|0)&1|m<<1}}else{T=0}m=4736+(T<<2)|0;c[N+(q+28)>>2]=T;c[N+(q+20)>>2]=0;c[N+(q+16)>>2]=0;h=c[4436>>2]|0;r=1<<T;if((h&r|0)==0){c[4436>>2]=h|r;c[m>>2]=e;c[N+(q+24)>>2]=m;c[N+(q+12)>>2]=e;c[N+(q+8)>>2]=e;break}r=c[m>>2]|0;if((T|0)==31){U=0}else{U=25-(T>>>1)|0}c:do{if((c[r+4>>2]&-8|0)!=(M|0)){m=M<<U;h=r;while(1){V=h+(m>>>31<<2)+16|0;s=c[V>>2]|0;if((s|0)==0){break}if((c[s+4>>2]&-8|0)==(M|0)){W=s;break c}else{m=m<<1;h=s}}if(V>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[V>>2]=e;c[N+(q+24)>>2]=h;c[N+(q+12)>>2]=e;c[N+(q+8)>>2]=e;break b}}else{W=r}}while(0);r=W+8|0;m=c[r>>2]|0;s=c[4448>>2]|0;if(W>>>0<s>>>0){sb()}if(m>>>0<s>>>0){sb()}else{c[m+12>>2]=e;c[r>>2]=e;c[N+(q+8)>>2]=m;c[N+(q+12)>>2]=W;c[N+(q+24)>>2]=0;break}}else{m=M+q|0;c[N+4>>2]=m|3;r=N+(m+4)|0;c[r>>2]=c[r>>2]|1}}while(0);p=N+8|0;i=b;return p|0}else{B=q}}else{B=q}}else{B=-1}}}while(0);N=c[4440>>2]|0;if(!(B>>>0>N>>>0)){M=N-B|0;W=c[4452>>2]|0;if(M>>>0>15){c[4452>>2]=W+B;c[4440>>2]=M;c[W+(B+4)>>2]=M|1;c[W+N>>2]=M;c[W+4>>2]=B|3}else{c[4440>>2]=0;c[4452>>2]=0;c[W+4>>2]=N|3;M=W+(N+4)|0;c[M>>2]=c[M>>2]|1}p=W+8|0;i=b;return p|0}W=c[4444>>2]|0;if(B>>>0<W>>>0){M=W-B|0;c[4444>>2]=M;W=c[4456>>2]|0;c[4456>>2]=W+B;c[W+(B+4)>>2]=M|1;c[W+4>>2]=B|3;p=W+8|0;i=b;return p|0}do{if((c[1226]|0)==0){W=Wa(30)|0;if((W+ -1&W|0)==0){c[4912>>2]=W;c[4908>>2]=W;c[4916>>2]=-1;c[4920>>2]=-1;c[4924>>2]=0;c[4876>>2]=0;c[1226]=(vb(0)|0)&-16^1431655768;break}else{sb()}}}while(0);W=B+48|0;M=c[4912>>2]|0;N=B+47|0;V=M+N|0;U=0-M|0;M=V&U;if(!(M>>>0>B>>>0)){p=0;i=b;return p|0}T=c[4872>>2]|0;if((T|0)!=0?(S=c[4864>>2]|0,R=S+M|0,R>>>0<=S>>>0|R>>>0>T>>>0):0){p=0;i=b;return p|0}d:do{if((c[4876>>2]&4|0)==0){T=c[4456>>2]|0;e:do{if((T|0)!=0){R=4880|0;while(1){S=c[R>>2]|0;if(!(S>>>0>T>>>0)?(X=R+4|0,(S+(c[X>>2]|0)|0)>>>0>T>>>0):0){break}S=c[R+8>>2]|0;if((S|0)==0){Y=182;break e}else{R=S}}if((R|0)!=0){S=V-(c[4444>>2]|0)&U;if(S>>>0<2147483647){O=Oa(S|0)|0;P=(O|0)==((c[R>>2]|0)+(c[X>>2]|0)|0);Z=O;_=S;$=P?O:-1;aa=P?S:0;Y=191}else{ba=0}}else{Y=182}}else{Y=182}}while(0);do{if((Y|0)==182){T=Oa(0)|0;if((T|0)!=(-1|0)){q=T;S=c[4908>>2]|0;P=S+ -1|0;if((P&q|0)==0){ca=M}else{ca=M-q+(P+q&0-S)|0}S=c[4864>>2]|0;q=S+ca|0;if(ca>>>0>B>>>0&ca>>>0<2147483647){P=c[4872>>2]|0;if((P|0)!=0?q>>>0<=S>>>0|q>>>0>P>>>0:0){ba=0;break}P=Oa(ca|0)|0;q=(P|0)==(T|0);Z=P;_=ca;$=q?T:-1;aa=q?ca:0;Y=191}else{ba=0}}else{ba=0}}}while(0);f:do{if((Y|0)==191){q=0-_|0;if(($|0)!=(-1|0)){da=$;ea=aa;Y=202;break d}do{if((Z|0)!=(-1|0)&_>>>0<2147483647&_>>>0<W>>>0?(T=c[4912>>2]|0,P=N-_+T&0-T,P>>>0<2147483647):0){if((Oa(P|0)|0)==(-1|0)){Oa(q|0)|0;ba=aa;break f}else{fa=P+_|0;break}}else{fa=_}}while(0);if((Z|0)==(-1|0)){ba=aa}else{da=Z;ea=fa;Y=202;break d}}}while(0);c[4876>>2]=c[4876>>2]|4;ga=ba;Y=199}else{ga=0;Y=199}}while(0);if((((Y|0)==199?M>>>0<2147483647:0)?(ba=Oa(M|0)|0,M=Oa(0)|0,(M|0)!=(-1|0)&(ba|0)!=(-1|0)&ba>>>0<M>>>0):0)?(fa=M-ba|0,M=fa>>>0>(B+40|0)>>>0,M):0){da=ba;ea=M?fa:ga;Y=202}if((Y|0)==202){ga=(c[4864>>2]|0)+ea|0;c[4864>>2]=ga;if(ga>>>0>(c[4868>>2]|0)>>>0){c[4868>>2]=ga}ga=c[4456>>2]|0;g:do{if((ga|0)!=0){fa=4880|0;while(1){ha=c[fa>>2]|0;ia=fa+4|0;ja=c[ia>>2]|0;if((da|0)==(ha+ja|0)){Y=214;break}M=c[fa+8>>2]|0;if((M|0)==0){break}else{fa=M}}if(((Y|0)==214?(c[fa+12>>2]&8|0)==0:0)?ga>>>0>=ha>>>0&ga>>>0<da>>>0:0){c[ia>>2]=ja+ea;M=(c[4444>>2]|0)+ea|0;ba=ga+8|0;if((ba&7|0)==0){ka=0}else{ka=0-ba&7}ba=M-ka|0;c[4456>>2]=ga+ka;c[4444>>2]=ba;c[ga+(ka+4)>>2]=ba|1;c[ga+(M+4)>>2]=40;c[4460>>2]=c[4920>>2];break}if(da>>>0<(c[4448>>2]|0)>>>0){c[4448>>2]=da}M=da+ea|0;ba=4880|0;while(1){if((c[ba>>2]|0)==(M|0)){Y=224;break}Z=c[ba+8>>2]|0;if((Z|0)==0){break}else{ba=Z}}if((Y|0)==224?(c[ba+12>>2]&8|0)==0:0){c[ba>>2]=da;M=ba+4|0;c[M>>2]=(c[M>>2]|0)+ea;M=da+8|0;if((M&7|0)==0){la=0}else{la=0-M&7}M=da+(ea+8)|0;if((M&7|0)==0){ma=0}else{ma=0-M&7}M=da+(ma+ea)|0;fa=la+B|0;Z=da+fa|0;aa=M-(da+la)-B|0;c[da+(la+4)>>2]=B|3;h:do{if((M|0)!=(c[4456>>2]|0)){if((M|0)==(c[4452>>2]|0)){_=(c[4440>>2]|0)+aa|0;c[4440>>2]=_;c[4452>>2]=Z;c[da+(fa+4)>>2]=_|1;c[da+(_+fa)>>2]=_;break}_=ea+4|0;N=c[da+(_+ma)>>2]|0;if((N&3|0)==1){W=N&-8;$=N>>>3;do{if(!(N>>>0<256)){ca=c[da+((ma|24)+ea)>>2]|0;X=c[da+(ea+12+ma)>>2]|0;do{if((X|0)==(M|0)){U=ma|16;V=da+(_+U)|0;q=c[V>>2]|0;if((q|0)==0){R=da+(U+ea)|0;U=c[R>>2]|0;if((U|0)==0){na=0;break}else{oa=U;pa=R}}else{oa=q;pa=V}while(1){V=oa+20|0;q=c[V>>2]|0;if((q|0)!=0){oa=q;pa=V;continue}V=oa+16|0;q=c[V>>2]|0;if((q|0)==0){break}else{oa=q;pa=V}}if(pa>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[pa>>2]=0;na=oa;break}}else{V=c[da+((ma|8)+ea)>>2]|0;if(V>>>0<(c[4448>>2]|0)>>>0){sb()}q=V+12|0;if((c[q>>2]|0)!=(M|0)){sb()}R=X+8|0;if((c[R>>2]|0)==(M|0)){c[q>>2]=X;c[R>>2]=V;na=X;break}else{sb()}}}while(0);if((ca|0)!=0){X=c[da+(ea+28+ma)>>2]|0;h=4736+(X<<2)|0;if((M|0)==(c[h>>2]|0)){c[h>>2]=na;if((na|0)==0){c[4436>>2]=c[4436>>2]&~(1<<X);break}}else{if(ca>>>0<(c[4448>>2]|0)>>>0){sb()}X=ca+16|0;if((c[X>>2]|0)==(M|0)){c[X>>2]=na}else{c[ca+20>>2]=na}if((na|0)==0){break}}if(na>>>0<(c[4448>>2]|0)>>>0){sb()}c[na+24>>2]=ca;X=ma|16;h=c[da+(X+ea)>>2]|0;do{if((h|0)!=0){if(h>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[na+16>>2]=h;c[h+24>>2]=na;break}}}while(0);h=c[da+(_+X)>>2]|0;if((h|0)!=0){if(h>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[na+20>>2]=h;c[h+24>>2]=na;break}}}}else{h=c[da+((ma|8)+ea)>>2]|0;ca=c[da+(ea+12+ma)>>2]|0;V=4472+($<<1<<2)|0;if((h|0)!=(V|0)){if(h>>>0<(c[4448>>2]|0)>>>0){sb()}if((c[h+12>>2]|0)!=(M|0)){sb()}}if((ca|0)==(h|0)){c[1108]=c[1108]&~(1<<$);break}if((ca|0)!=(V|0)){if(ca>>>0<(c[4448>>2]|0)>>>0){sb()}V=ca+8|0;if((c[V>>2]|0)==(M|0)){qa=V}else{sb()}}else{qa=ca+8|0}c[h+12>>2]=ca;c[qa>>2]=h}}while(0);ra=da+((W|ma)+ea)|0;sa=W+aa|0}else{ra=M;sa=aa}$=ra+4|0;c[$>>2]=c[$>>2]&-2;c[da+(fa+4)>>2]=sa|1;c[da+(sa+fa)>>2]=sa;$=sa>>>3;if(sa>>>0<256){_=$<<1;N=4472+(_<<2)|0;h=c[1108]|0;ca=1<<$;if((h&ca|0)!=0){$=4472+(_+2<<2)|0;V=c[$>>2]|0;if(V>>>0<(c[4448>>2]|0)>>>0){sb()}else{ta=$;ua=V}}else{c[1108]=h|ca;ta=4472+(_+2<<2)|0;ua=N}c[ta>>2]=Z;c[ua+12>>2]=Z;c[da+(fa+8)>>2]=ua;c[da+(fa+12)>>2]=N;break}N=sa>>>8;if((N|0)!=0){if(sa>>>0>16777215){va=31}else{_=(N+1048320|0)>>>16&8;ca=N<<_;N=(ca+520192|0)>>>16&4;h=ca<<N;ca=(h+245760|0)>>>16&2;V=14-(N|_|ca)+(h<<ca>>>15)|0;va=sa>>>(V+7|0)&1|V<<1}}else{va=0}V=4736+(va<<2)|0;c[da+(fa+28)>>2]=va;c[da+(fa+20)>>2]=0;c[da+(fa+16)>>2]=0;ca=c[4436>>2]|0;h=1<<va;if((ca&h|0)==0){c[4436>>2]=ca|h;c[V>>2]=Z;c[da+(fa+24)>>2]=V;c[da+(fa+12)>>2]=Z;c[da+(fa+8)>>2]=Z;break}h=c[V>>2]|0;if((va|0)==31){wa=0}else{wa=25-(va>>>1)|0}i:do{if((c[h+4>>2]&-8|0)!=(sa|0)){V=sa<<wa;ca=h;while(1){xa=ca+(V>>>31<<2)+16|0;_=c[xa>>2]|0;if((_|0)==0){break}if((c[_+4>>2]&-8|0)==(sa|0)){ya=_;break i}else{V=V<<1;ca=_}}if(xa>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[xa>>2]=Z;c[da+(fa+24)>>2]=ca;c[da+(fa+12)>>2]=Z;c[da+(fa+8)>>2]=Z;break h}}else{ya=h}}while(0);h=ya+8|0;W=c[h>>2]|0;V=c[4448>>2]|0;if(ya>>>0<V>>>0){sb()}if(W>>>0<V>>>0){sb()}else{c[W+12>>2]=Z;c[h>>2]=Z;c[da+(fa+8)>>2]=W;c[da+(fa+12)>>2]=ya;c[da+(fa+24)>>2]=0;break}}else{W=(c[4444>>2]|0)+aa|0;c[4444>>2]=W;c[4456>>2]=Z;c[da+(fa+4)>>2]=W|1}}while(0);p=da+(la|8)|0;i=b;return p|0}fa=4880|0;while(1){za=c[fa>>2]|0;if(!(za>>>0>ga>>>0)?(Aa=c[fa+4>>2]|0,Ba=za+Aa|0,Ba>>>0>ga>>>0):0){break}fa=c[fa+8>>2]|0}fa=za+(Aa+ -39)|0;if((fa&7|0)==0){Ca=0}else{Ca=0-fa&7}fa=za+(Aa+ -47+Ca)|0;Z=fa>>>0<(ga+16|0)>>>0?ga:fa;fa=Z+8|0;aa=da+8|0;if((aa&7|0)==0){Da=0}else{Da=0-aa&7}aa=ea+ -40-Da|0;c[4456>>2]=da+Da;c[4444>>2]=aa;c[da+(Da+4)>>2]=aa|1;c[da+(ea+ -36)>>2]=40;c[4460>>2]=c[4920>>2];c[Z+4>>2]=27;c[fa+0>>2]=c[4880>>2];c[fa+4>>2]=c[4884>>2];c[fa+8>>2]=c[4888>>2];c[fa+12>>2]=c[4892>>2];c[4880>>2]=da;c[4884>>2]=ea;c[4892>>2]=0;c[4888>>2]=fa;fa=Z+28|0;c[fa>>2]=7;if((Z+32|0)>>>0<Ba>>>0){aa=fa;do{fa=aa;aa=aa+4|0;c[aa>>2]=7}while((fa+8|0)>>>0<Ba>>>0)}if((Z|0)!=(ga|0)){aa=Z-ga|0;fa=ga+(aa+4)|0;c[fa>>2]=c[fa>>2]&-2;c[ga+4>>2]=aa|1;c[ga+aa>>2]=aa;fa=aa>>>3;if(aa>>>0<256){M=fa<<1;ba=4472+(M<<2)|0;W=c[1108]|0;h=1<<fa;if((W&h|0)!=0){fa=4472+(M+2<<2)|0;V=c[fa>>2]|0;if(V>>>0<(c[4448>>2]|0)>>>0){sb()}else{Ea=fa;Fa=V}}else{c[1108]=W|h;Ea=4472+(M+2<<2)|0;Fa=ba}c[Ea>>2]=ga;c[Fa+12>>2]=ga;c[ga+8>>2]=Fa;c[ga+12>>2]=ba;break}ba=aa>>>8;if((ba|0)!=0){if(aa>>>0>16777215){Ga=31}else{M=(ba+1048320|0)>>>16&8;h=ba<<M;ba=(h+520192|0)>>>16&4;W=h<<ba;h=(W+245760|0)>>>16&2;V=14-(ba|M|h)+(W<<h>>>15)|0;Ga=aa>>>(V+7|0)&1|V<<1}}else{Ga=0}V=4736+(Ga<<2)|0;c[ga+28>>2]=Ga;c[ga+20>>2]=0;c[ga+16>>2]=0;h=c[4436>>2]|0;W=1<<Ga;if((h&W|0)==0){c[4436>>2]=h|W;c[V>>2]=ga;c[ga+24>>2]=V;c[ga+12>>2]=ga;c[ga+8>>2]=ga;break}W=c[V>>2]|0;if((Ga|0)==31){Ha=0}else{Ha=25-(Ga>>>1)|0}j:do{if((c[W+4>>2]&-8|0)!=(aa|0)){V=aa<<Ha;h=W;while(1){Ia=h+(V>>>31<<2)+16|0;M=c[Ia>>2]|0;if((M|0)==0){break}if((c[M+4>>2]&-8|0)==(aa|0)){Ja=M;break j}else{V=V<<1;h=M}}if(Ia>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[Ia>>2]=ga;c[ga+24>>2]=h;c[ga+12>>2]=ga;c[ga+8>>2]=ga;break g}}else{Ja=W}}while(0);W=Ja+8|0;aa=c[W>>2]|0;Z=c[4448>>2]|0;if(Ja>>>0<Z>>>0){sb()}if(aa>>>0<Z>>>0){sb()}else{c[aa+12>>2]=ga;c[W>>2]=ga;c[ga+8>>2]=aa;c[ga+12>>2]=Ja;c[ga+24>>2]=0;break}}}else{aa=c[4448>>2]|0;if((aa|0)==0|da>>>0<aa>>>0){c[4448>>2]=da}c[4880>>2]=da;c[4884>>2]=ea;c[4892>>2]=0;c[4468>>2]=c[1226];c[4464>>2]=-1;aa=0;do{W=aa<<1;Z=4472+(W<<2)|0;c[4472+(W+3<<2)>>2]=Z;c[4472+(W+2<<2)>>2]=Z;aa=aa+1|0}while((aa|0)!=32);aa=da+8|0;if((aa&7|0)==0){Ka=0}else{Ka=0-aa&7}aa=ea+ -40-Ka|0;c[4456>>2]=da+Ka;c[4444>>2]=aa;c[da+(Ka+4)>>2]=aa|1;c[da+(ea+ -36)>>2]=40;c[4460>>2]=c[4920>>2]}}while(0);ea=c[4444>>2]|0;if(ea>>>0>B>>>0){da=ea-B|0;c[4444>>2]=da;ea=c[4456>>2]|0;c[4456>>2]=ea+B;c[ea+(B+4)>>2]=da|1;c[ea+4>>2]=B|3;p=ea+8|0;i=b;return p|0}}c[(Sa()|0)>>2]=12;p=0;i=b;return p|0}function Jf(a){a=a|0;var b=0,d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0;b=i;if((a|0)==0){i=b;return}d=a+ -8|0;e=c[4448>>2]|0;if(d>>>0<e>>>0){sb()}f=c[a+ -4>>2]|0;g=f&3;if((g|0)==1){sb()}h=f&-8;j=a+(h+ -8)|0;do{if((f&1|0)==0){k=c[d>>2]|0;if((g|0)==0){i=b;return}l=-8-k|0;m=a+l|0;n=k+h|0;if(m>>>0<e>>>0){sb()}if((m|0)==(c[4452>>2]|0)){o=a+(h+ -4)|0;if((c[o>>2]&3|0)!=3){p=m;q=n;break}c[4440>>2]=n;c[o>>2]=c[o>>2]&-2;c[a+(l+4)>>2]=n|1;c[j>>2]=n;i=b;return}o=k>>>3;if(k>>>0<256){k=c[a+(l+8)>>2]|0;r=c[a+(l+12)>>2]|0;s=4472+(o<<1<<2)|0;if((k|0)!=(s|0)){if(k>>>0<e>>>0){sb()}if((c[k+12>>2]|0)!=(m|0)){sb()}}if((r|0)==(k|0)){c[1108]=c[1108]&~(1<<o);p=m;q=n;break}if((r|0)!=(s|0)){if(r>>>0<e>>>0){sb()}s=r+8|0;if((c[s>>2]|0)==(m|0)){t=s}else{sb()}}else{t=r+8|0}c[k+12>>2]=r;c[t>>2]=k;p=m;q=n;break}k=c[a+(l+24)>>2]|0;r=c[a+(l+12)>>2]|0;do{if((r|0)==(m|0)){s=a+(l+20)|0;o=c[s>>2]|0;if((o|0)==0){u=a+(l+16)|0;v=c[u>>2]|0;if((v|0)==0){w=0;break}else{x=v;y=u}}else{x=o;y=s}while(1){s=x+20|0;o=c[s>>2]|0;if((o|0)!=0){x=o;y=s;continue}s=x+16|0;o=c[s>>2]|0;if((o|0)==0){break}else{x=o;y=s}}if(y>>>0<e>>>0){sb()}else{c[y>>2]=0;w=x;break}}else{s=c[a+(l+8)>>2]|0;if(s>>>0<e>>>0){sb()}o=s+12|0;if((c[o>>2]|0)!=(m|0)){sb()}u=r+8|0;if((c[u>>2]|0)==(m|0)){c[o>>2]=r;c[u>>2]=s;w=r;break}else{sb()}}}while(0);if((k|0)!=0){r=c[a+(l+28)>>2]|0;s=4736+(r<<2)|0;if((m|0)==(c[s>>2]|0)){c[s>>2]=w;if((w|0)==0){c[4436>>2]=c[4436>>2]&~(1<<r);p=m;q=n;break}}else{if(k>>>0<(c[4448>>2]|0)>>>0){sb()}r=k+16|0;if((c[r>>2]|0)==(m|0)){c[r>>2]=w}else{c[k+20>>2]=w}if((w|0)==0){p=m;q=n;break}}if(w>>>0<(c[4448>>2]|0)>>>0){sb()}c[w+24>>2]=k;r=c[a+(l+16)>>2]|0;do{if((r|0)!=0){if(r>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[w+16>>2]=r;c[r+24>>2]=w;break}}}while(0);r=c[a+(l+20)>>2]|0;if((r|0)!=0){if(r>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[w+20>>2]=r;c[r+24>>2]=w;p=m;q=n;break}}else{p=m;q=n}}else{p=m;q=n}}else{p=d;q=h}}while(0);if(!(p>>>0<j>>>0)){sb()}d=a+(h+ -4)|0;w=c[d>>2]|0;if((w&1|0)==0){sb()}if((w&2|0)==0){if((j|0)==(c[4456>>2]|0)){e=(c[4444>>2]|0)+q|0;c[4444>>2]=e;c[4456>>2]=p;c[p+4>>2]=e|1;if((p|0)!=(c[4452>>2]|0)){i=b;return}c[4452>>2]=0;c[4440>>2]=0;i=b;return}if((j|0)==(c[4452>>2]|0)){e=(c[4440>>2]|0)+q|0;c[4440>>2]=e;c[4452>>2]=p;c[p+4>>2]=e|1;c[p+e>>2]=e;i=b;return}e=(w&-8)+q|0;x=w>>>3;do{if(!(w>>>0<256)){y=c[a+(h+16)>>2]|0;t=c[a+(h|4)>>2]|0;do{if((t|0)==(j|0)){g=a+(h+12)|0;f=c[g>>2]|0;if((f|0)==0){r=a+(h+8)|0;k=c[r>>2]|0;if((k|0)==0){z=0;break}else{A=k;B=r}}else{A=f;B=g}while(1){g=A+20|0;f=c[g>>2]|0;if((f|0)!=0){A=f;B=g;continue}g=A+16|0;f=c[g>>2]|0;if((f|0)==0){break}else{A=f;B=g}}if(B>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[B>>2]=0;z=A;break}}else{g=c[a+h>>2]|0;if(g>>>0<(c[4448>>2]|0)>>>0){sb()}f=g+12|0;if((c[f>>2]|0)!=(j|0)){sb()}r=t+8|0;if((c[r>>2]|0)==(j|0)){c[f>>2]=t;c[r>>2]=g;z=t;break}else{sb()}}}while(0);if((y|0)!=0){t=c[a+(h+20)>>2]|0;n=4736+(t<<2)|0;if((j|0)==(c[n>>2]|0)){c[n>>2]=z;if((z|0)==0){c[4436>>2]=c[4436>>2]&~(1<<t);break}}else{if(y>>>0<(c[4448>>2]|0)>>>0){sb()}t=y+16|0;if((c[t>>2]|0)==(j|0)){c[t>>2]=z}else{c[y+20>>2]=z}if((z|0)==0){break}}if(z>>>0<(c[4448>>2]|0)>>>0){sb()}c[z+24>>2]=y;t=c[a+(h+8)>>2]|0;do{if((t|0)!=0){if(t>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[z+16>>2]=t;c[t+24>>2]=z;break}}}while(0);t=c[a+(h+12)>>2]|0;if((t|0)!=0){if(t>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[z+20>>2]=t;c[t+24>>2]=z;break}}}}else{t=c[a+h>>2]|0;y=c[a+(h|4)>>2]|0;n=4472+(x<<1<<2)|0;if((t|0)!=(n|0)){if(t>>>0<(c[4448>>2]|0)>>>0){sb()}if((c[t+12>>2]|0)!=(j|0)){sb()}}if((y|0)==(t|0)){c[1108]=c[1108]&~(1<<x);break}if((y|0)!=(n|0)){if(y>>>0<(c[4448>>2]|0)>>>0){sb()}n=y+8|0;if((c[n>>2]|0)==(j|0)){C=n}else{sb()}}else{C=y+8|0}c[t+12>>2]=y;c[C>>2]=t}}while(0);c[p+4>>2]=e|1;c[p+e>>2]=e;if((p|0)==(c[4452>>2]|0)){c[4440>>2]=e;i=b;return}else{D=e}}else{c[d>>2]=w&-2;c[p+4>>2]=q|1;c[p+q>>2]=q;D=q}q=D>>>3;if(D>>>0<256){w=q<<1;d=4472+(w<<2)|0;e=c[1108]|0;C=1<<q;if((e&C|0)!=0){q=4472+(w+2<<2)|0;j=c[q>>2]|0;if(j>>>0<(c[4448>>2]|0)>>>0){sb()}else{E=q;F=j}}else{c[1108]=e|C;E=4472+(w+2<<2)|0;F=d}c[E>>2]=p;c[F+12>>2]=p;c[p+8>>2]=F;c[p+12>>2]=d;i=b;return}d=D>>>8;if((d|0)!=0){if(D>>>0>16777215){G=31}else{F=(d+1048320|0)>>>16&8;E=d<<F;d=(E+520192|0)>>>16&4;w=E<<d;E=(w+245760|0)>>>16&2;C=14-(d|F|E)+(w<<E>>>15)|0;G=D>>>(C+7|0)&1|C<<1}}else{G=0}C=4736+(G<<2)|0;c[p+28>>2]=G;c[p+20>>2]=0;c[p+16>>2]=0;E=c[4436>>2]|0;w=1<<G;a:do{if((E&w|0)!=0){F=c[C>>2]|0;if((G|0)==31){H=0}else{H=25-(G>>>1)|0}b:do{if((c[F+4>>2]&-8|0)!=(D|0)){d=D<<H;e=F;while(1){I=e+(d>>>31<<2)+16|0;j=c[I>>2]|0;if((j|0)==0){break}if((c[j+4>>2]&-8|0)==(D|0)){J=j;break b}else{d=d<<1;e=j}}if(I>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[I>>2]=p;c[p+24>>2]=e;c[p+12>>2]=p;c[p+8>>2]=p;break a}}else{J=F}}while(0);F=J+8|0;d=c[F>>2]|0;j=c[4448>>2]|0;if(J>>>0<j>>>0){sb()}if(d>>>0<j>>>0){sb()}else{c[d+12>>2]=p;c[F>>2]=p;c[p+8>>2]=d;c[p+12>>2]=J;c[p+24>>2]=0;break}}else{c[4436>>2]=E|w;c[C>>2]=p;c[p+24>>2]=C;c[p+12>>2]=p;c[p+8>>2]=p}}while(0);p=(c[4464>>2]|0)+ -1|0;c[4464>>2]=p;if((p|0)==0){K=4888|0}else{i=b;return}while(1){p=c[K>>2]|0;if((p|0)==0){break}else{K=p+8|0}}c[4464>>2]=-1;i=b;return}function Kf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0;d=i;do{if((a|0)!=0){if(b>>>0>4294967231){c[(Sa()|0)>>2]=12;e=0;break}if(b>>>0<11){f=16}else{f=b+11&-8}g=Lf(a+ -8|0,f)|0;if((g|0)!=0){e=g+8|0;break}g=If(b)|0;if((g|0)==0){e=0}else{h=c[a+ -4>>2]|0;j=(h&-8)-((h&3|0)==0?8:4)|0;bg(g|0,a|0,(j>>>0<b>>>0?j:b)|0)|0;Jf(a);e=g}}else{e=If(b)|0}}while(0);i=d;return e|0}function Lf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0;d=i;e=a+4|0;f=c[e>>2]|0;g=f&-8;h=a+g|0;j=c[4448>>2]|0;if(a>>>0<j>>>0){sb()}k=f&3;if(!((k|0)!=1&a>>>0<h>>>0)){sb()}l=a+(g|4)|0;m=c[l>>2]|0;if((m&1|0)==0){sb()}if((k|0)==0){if(b>>>0<256){n=0;i=d;return n|0}if(!(g>>>0<(b+4|0)>>>0)?!((g-b|0)>>>0>c[4912>>2]<<1>>>0):0){n=a;i=d;return n|0}n=0;i=d;return n|0}if(!(g>>>0<b>>>0)){k=g-b|0;if(!(k>>>0>15)){n=a;i=d;return n|0}c[e>>2]=f&1|b|2;c[a+(b+4)>>2]=k|3;c[l>>2]=c[l>>2]|1;Mf(a+b|0,k);n=a;i=d;return n|0}if((h|0)==(c[4456>>2]|0)){k=(c[4444>>2]|0)+g|0;if(!(k>>>0>b>>>0)){n=0;i=d;return n|0}l=k-b|0;c[e>>2]=f&1|b|2;c[a+(b+4)>>2]=l|1;c[4456>>2]=a+b;c[4444>>2]=l;n=a;i=d;return n|0}if((h|0)==(c[4452>>2]|0)){l=(c[4440>>2]|0)+g|0;if(l>>>0<b>>>0){n=0;i=d;return n|0}k=l-b|0;if(k>>>0>15){c[e>>2]=f&1|b|2;c[a+(b+4)>>2]=k|1;c[a+l>>2]=k;o=a+(l+4)|0;c[o>>2]=c[o>>2]&-2;p=a+b|0;q=k}else{c[e>>2]=f&1|l|2;f=a+(l+4)|0;c[f>>2]=c[f>>2]|1;p=0;q=0}c[4440>>2]=q;c[4452>>2]=p;n=a;i=d;return n|0}if((m&2|0)!=0){n=0;i=d;return n|0}p=(m&-8)+g|0;if(p>>>0<b>>>0){n=0;i=d;return n|0}q=p-b|0;f=m>>>3;do{if(!(m>>>0<256)){l=c[a+(g+24)>>2]|0;k=c[a+(g+12)>>2]|0;do{if((k|0)==(h|0)){o=a+(g+20)|0;r=c[o>>2]|0;if((r|0)==0){s=a+(g+16)|0;t=c[s>>2]|0;if((t|0)==0){u=0;break}else{v=t;w=s}}else{v=r;w=o}while(1){o=v+20|0;r=c[o>>2]|0;if((r|0)!=0){v=r;w=o;continue}o=v+16|0;r=c[o>>2]|0;if((r|0)==0){break}else{v=r;w=o}}if(w>>>0<j>>>0){sb()}else{c[w>>2]=0;u=v;break}}else{o=c[a+(g+8)>>2]|0;if(o>>>0<j>>>0){sb()}r=o+12|0;if((c[r>>2]|0)!=(h|0)){sb()}s=k+8|0;if((c[s>>2]|0)==(h|0)){c[r>>2]=k;c[s>>2]=o;u=k;break}else{sb()}}}while(0);if((l|0)!=0){k=c[a+(g+28)>>2]|0;o=4736+(k<<2)|0;if((h|0)==(c[o>>2]|0)){c[o>>2]=u;if((u|0)==0){c[4436>>2]=c[4436>>2]&~(1<<k);break}}else{if(l>>>0<(c[4448>>2]|0)>>>0){sb()}k=l+16|0;if((c[k>>2]|0)==(h|0)){c[k>>2]=u}else{c[l+20>>2]=u}if((u|0)==0){break}}if(u>>>0<(c[4448>>2]|0)>>>0){sb()}c[u+24>>2]=l;k=c[a+(g+16)>>2]|0;do{if((k|0)!=0){if(k>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[u+16>>2]=k;c[k+24>>2]=u;break}}}while(0);k=c[a+(g+20)>>2]|0;if((k|0)!=0){if(k>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[u+20>>2]=k;c[k+24>>2]=u;break}}}}else{k=c[a+(g+8)>>2]|0;l=c[a+(g+12)>>2]|0;o=4472+(f<<1<<2)|0;if((k|0)!=(o|0)){if(k>>>0<j>>>0){sb()}if((c[k+12>>2]|0)!=(h|0)){sb()}}if((l|0)==(k|0)){c[1108]=c[1108]&~(1<<f);break}if((l|0)!=(o|0)){if(l>>>0<j>>>0){sb()}o=l+8|0;if((c[o>>2]|0)==(h|0)){x=o}else{sb()}}else{x=l+8|0}c[k+12>>2]=l;c[x>>2]=k}}while(0);if(q>>>0<16){c[e>>2]=p|c[e>>2]&1|2;x=a+(p|4)|0;c[x>>2]=c[x>>2]|1;n=a;i=d;return n|0}else{c[e>>2]=c[e>>2]&1|b|2;c[a+(b+4)>>2]=q|3;e=a+(p|4)|0;c[e>>2]=c[e>>2]|1;Mf(a+b|0,q);n=a;i=d;return n|0}return 0}function Mf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,D=0,E=0,F=0,G=0,H=0;d=i;e=a+b|0;f=c[a+4>>2]|0;do{if((f&1|0)==0){g=c[a>>2]|0;if((f&3|0)==0){i=d;return}h=a+(0-g)|0;j=g+b|0;k=c[4448>>2]|0;if(h>>>0<k>>>0){sb()}if((h|0)==(c[4452>>2]|0)){l=a+(b+4)|0;if((c[l>>2]&3|0)!=3){m=h;n=j;break}c[4440>>2]=j;c[l>>2]=c[l>>2]&-2;c[a+(4-g)>>2]=j|1;c[e>>2]=j;i=d;return}l=g>>>3;if(g>>>0<256){o=c[a+(8-g)>>2]|0;p=c[a+(12-g)>>2]|0;q=4472+(l<<1<<2)|0;if((o|0)!=(q|0)){if(o>>>0<k>>>0){sb()}if((c[o+12>>2]|0)!=(h|0)){sb()}}if((p|0)==(o|0)){c[1108]=c[1108]&~(1<<l);m=h;n=j;break}if((p|0)!=(q|0)){if(p>>>0<k>>>0){sb()}q=p+8|0;if((c[q>>2]|0)==(h|0)){r=q}else{sb()}}else{r=p+8|0}c[o+12>>2]=p;c[r>>2]=o;m=h;n=j;break}o=c[a+(24-g)>>2]|0;p=c[a+(12-g)>>2]|0;do{if((p|0)==(h|0)){q=16-g|0;l=a+(q+4)|0;s=c[l>>2]|0;if((s|0)==0){t=a+q|0;q=c[t>>2]|0;if((q|0)==0){u=0;break}else{v=q;w=t}}else{v=s;w=l}while(1){l=v+20|0;s=c[l>>2]|0;if((s|0)!=0){v=s;w=l;continue}l=v+16|0;s=c[l>>2]|0;if((s|0)==0){break}else{v=s;w=l}}if(w>>>0<k>>>0){sb()}else{c[w>>2]=0;u=v;break}}else{l=c[a+(8-g)>>2]|0;if(l>>>0<k>>>0){sb()}s=l+12|0;if((c[s>>2]|0)!=(h|0)){sb()}t=p+8|0;if((c[t>>2]|0)==(h|0)){c[s>>2]=p;c[t>>2]=l;u=p;break}else{sb()}}}while(0);if((o|0)!=0){p=c[a+(28-g)>>2]|0;k=4736+(p<<2)|0;if((h|0)==(c[k>>2]|0)){c[k>>2]=u;if((u|0)==0){c[4436>>2]=c[4436>>2]&~(1<<p);m=h;n=j;break}}else{if(o>>>0<(c[4448>>2]|0)>>>0){sb()}p=o+16|0;if((c[p>>2]|0)==(h|0)){c[p>>2]=u}else{c[o+20>>2]=u}if((u|0)==0){m=h;n=j;break}}if(u>>>0<(c[4448>>2]|0)>>>0){sb()}c[u+24>>2]=o;p=16-g|0;k=c[a+p>>2]|0;do{if((k|0)!=0){if(k>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[u+16>>2]=k;c[k+24>>2]=u;break}}}while(0);k=c[a+(p+4)>>2]|0;if((k|0)!=0){if(k>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[u+20>>2]=k;c[k+24>>2]=u;m=h;n=j;break}}else{m=h;n=j}}else{m=h;n=j}}else{m=a;n=b}}while(0);u=c[4448>>2]|0;if(e>>>0<u>>>0){sb()}v=a+(b+4)|0;w=c[v>>2]|0;if((w&2|0)==0){if((e|0)==(c[4456>>2]|0)){r=(c[4444>>2]|0)+n|0;c[4444>>2]=r;c[4456>>2]=m;c[m+4>>2]=r|1;if((m|0)!=(c[4452>>2]|0)){i=d;return}c[4452>>2]=0;c[4440>>2]=0;i=d;return}if((e|0)==(c[4452>>2]|0)){r=(c[4440>>2]|0)+n|0;c[4440>>2]=r;c[4452>>2]=m;c[m+4>>2]=r|1;c[m+r>>2]=r;i=d;return}r=(w&-8)+n|0;f=w>>>3;do{if(!(w>>>0<256)){k=c[a+(b+24)>>2]|0;g=c[a+(b+12)>>2]|0;do{if((g|0)==(e|0)){o=a+(b+20)|0;l=c[o>>2]|0;if((l|0)==0){t=a+(b+16)|0;s=c[t>>2]|0;if((s|0)==0){x=0;break}else{y=s;z=t}}else{y=l;z=o}while(1){o=y+20|0;l=c[o>>2]|0;if((l|0)!=0){y=l;z=o;continue}o=y+16|0;l=c[o>>2]|0;if((l|0)==0){break}else{y=l;z=o}}if(z>>>0<u>>>0){sb()}else{c[z>>2]=0;x=y;break}}else{o=c[a+(b+8)>>2]|0;if(o>>>0<u>>>0){sb()}l=o+12|0;if((c[l>>2]|0)!=(e|0)){sb()}t=g+8|0;if((c[t>>2]|0)==(e|0)){c[l>>2]=g;c[t>>2]=o;x=g;break}else{sb()}}}while(0);if((k|0)!=0){g=c[a+(b+28)>>2]|0;j=4736+(g<<2)|0;if((e|0)==(c[j>>2]|0)){c[j>>2]=x;if((x|0)==0){c[4436>>2]=c[4436>>2]&~(1<<g);break}}else{if(k>>>0<(c[4448>>2]|0)>>>0){sb()}g=k+16|0;if((c[g>>2]|0)==(e|0)){c[g>>2]=x}else{c[k+20>>2]=x}if((x|0)==0){break}}if(x>>>0<(c[4448>>2]|0)>>>0){sb()}c[x+24>>2]=k;g=c[a+(b+16)>>2]|0;do{if((g|0)!=0){if(g>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[x+16>>2]=g;c[g+24>>2]=x;break}}}while(0);g=c[a+(b+20)>>2]|0;if((g|0)!=0){if(g>>>0<(c[4448>>2]|0)>>>0){sb()}else{c[x+20>>2]=g;c[g+24>>2]=x;break}}}}else{g=c[a+(b+8)>>2]|0;k=c[a+(b+12)>>2]|0;j=4472+(f<<1<<2)|0;if((g|0)!=(j|0)){if(g>>>0<u>>>0){sb()}if((c[g+12>>2]|0)!=(e|0)){sb()}}if((k|0)==(g|0)){c[1108]=c[1108]&~(1<<f);break}if((k|0)!=(j|0)){if(k>>>0<u>>>0){sb()}j=k+8|0;if((c[j>>2]|0)==(e|0)){A=j}else{sb()}}else{A=k+8|0}c[g+12>>2]=k;c[A>>2]=g}}while(0);c[m+4>>2]=r|1;c[m+r>>2]=r;if((m|0)==(c[4452>>2]|0)){c[4440>>2]=r;i=d;return}else{B=r}}else{c[v>>2]=w&-2;c[m+4>>2]=n|1;c[m+n>>2]=n;B=n}n=B>>>3;if(B>>>0<256){w=n<<1;v=4472+(w<<2)|0;r=c[1108]|0;A=1<<n;if((r&A|0)!=0){n=4472+(w+2<<2)|0;e=c[n>>2]|0;if(e>>>0<(c[4448>>2]|0)>>>0){sb()}else{C=n;D=e}}else{c[1108]=r|A;C=4472+(w+2<<2)|0;D=v}c[C>>2]=m;c[D+12>>2]=m;c[m+8>>2]=D;c[m+12>>2]=v;i=d;return}v=B>>>8;if((v|0)!=0){if(B>>>0>16777215){E=31}else{D=(v+1048320|0)>>>16&8;C=v<<D;v=(C+520192|0)>>>16&4;w=C<<v;C=(w+245760|0)>>>16&2;A=14-(v|D|C)+(w<<C>>>15)|0;E=B>>>(A+7|0)&1|A<<1}}else{E=0}A=4736+(E<<2)|0;c[m+28>>2]=E;c[m+20>>2]=0;c[m+16>>2]=0;C=c[4436>>2]|0;w=1<<E;if((C&w|0)==0){c[4436>>2]=C|w;c[A>>2]=m;c[m+24>>2]=A;c[m+12>>2]=m;c[m+8>>2]=m;i=d;return}w=c[A>>2]|0;if((E|0)==31){F=0}else{F=25-(E>>>1)|0}a:do{if((c[w+4>>2]&-8|0)==(B|0)){G=w}else{E=B<<F;A=w;while(1){H=A+(E>>>31<<2)+16|0;C=c[H>>2]|0;if((C|0)==0){break}if((c[C+4>>2]&-8|0)==(B|0)){G=C;break a}else{E=E<<1;A=C}}if(H>>>0<(c[4448>>2]|0)>>>0){sb()}c[H>>2]=m;c[m+24>>2]=A;c[m+12>>2]=m;c[m+8>>2]=m;i=d;return}}while(0);H=G+8|0;B=c[H>>2]|0;w=c[4448>>2]|0;if(G>>>0<w>>>0){sb()}if(B>>>0<w>>>0){sb()}c[B+12>>2]=m;c[H>>2]=m;c[m+8>>2]=B;c[m+12>>2]=G;c[m+24>>2]=0;i=d;return}function Nf(b,e,f){b=b|0;e=e|0;f=f|0;var g=0,h=0,j=0,k=0,l=0.0,m=0,n=0,o=0,p=0,q=0,r=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,E=0,F=0,G=0,H=0,I=0,J=0,K=0,L=0,M=0,N=0,P=0.0,Q=0,R=0.0,S=0,T=0,U=0,V=0,W=0,X=0,Y=0,Z=0,_=0,aa=0,ba=0.0,ca=0,da=0.0,ea=0,fa=0.0,ga=0,ha=0.0,ia=0,ja=0.0,ka=0,la=0,ma=0,na=0,oa=0,pa=0,qa=0,ra=0.0,sa=0,ta=0.0,ua=0,va=0,wa=0,xa=0,ya=0.0,za=0,Aa=0.0,Ba=0.0,Da=0,Ea=0.0,Fa=0,Ga=0,Ha=0,Ia=0,Ja=0,Ka=0,La=0,Ma=0,Na=0,Oa=0,Pa=0,Qa=0,Ra=0,Ta=0,Ua=0,Va=0,Wa=0,Xa=0,Ya=0,Za=0,_a=0,$a=0,ab=0,cb=0,db=0,eb=0,fb=0,gb=0,hb=0,ib=0,jb=0,kb=0,lb=0,mb=0,nb=0,ob=0,qb=0,rb=0,sb=0,tb=0,ub=0,vb=0,wb=0,xb=0,yb=0,zb=0,Ab=0,Bb=0,Cb=0,Db=0,Eb=0,Fb=0,Gb=0,Hb=0,Ib=0,Jb=0,Kb=0,Lb=0,Mb=0,Nb=0,Ob=0,Pb=0,Qb=0,Rb=0,Sb=0,Tb=0,Ub=0,Vb=0,Wb=0,Xb=0,Yb=0,Zb=0,_b=0,$b=0,ac=0,bc=0,cc=0,dc=0,ec=0,fc=0,gc=0,hc=0,ic=0,jc=0,kc=0,lc=0,mc=0,nc=0,oc=0,pc=0,qc=0.0,rc=0,sc=0,tc=0.0,uc=0.0,vc=0.0,wc=0.0,xc=0.0,yc=0.0,zc=0,Ac=0,Bc=0.0,Cc=0,Dc=0.0,Ec=0,Fc=0,Gc=0,Hc=0;g=i;i=i+512|0;h=g;if((e|0)==0){j=24;k=-149}else if((e|0)==2){j=53;k=-1074}else if((e|0)==1){j=53;k=-1074}else{l=0.0;i=g;return+l}e=b+4|0;m=b+100|0;do{n=c[e>>2]|0;if(n>>>0<(c[m>>2]|0)>>>0){c[e>>2]=n+1;o=d[n]|0}else{o=Qf(b)|0}}while((bb(o|0)|0)!=0);do{if((o|0)==43|(o|0)==45){n=1-(((o|0)==45)<<1)|0;p=c[e>>2]|0;if(p>>>0<(c[m>>2]|0)>>>0){c[e>>2]=p+1;q=d[p]|0;r=n;break}else{q=Qf(b)|0;r=n;break}}else{q=o;r=1}}while(0);o=q;q=0;while(1){if((o|32|0)!=(a[4928+q|0]|0)){u=o;v=q;break}do{if(q>>>0<7){n=c[e>>2]|0;if(n>>>0<(c[m>>2]|0)>>>0){c[e>>2]=n+1;w=d[n]|0;break}else{w=Qf(b)|0;break}}else{w=o}}while(0);n=q+1|0;if(n>>>0<8){o=w;q=n}else{u=w;v=n;break}}do{if((v|0)==3){x=23}else if((v|0)!=8){w=(f|0)==0;if(!(v>>>0<4|w)){if((v|0)==8){break}else{x=23;break}}a:do{if((v|0)==0){q=u;o=0;while(1){if((q|32|0)!=(a[4944+o|0]|0)){y=q;z=o;break a}do{if(o>>>0<2){n=c[e>>2]|0;if(n>>>0<(c[m>>2]|0)>>>0){c[e>>2]=n+1;A=d[n]|0;break}else{A=Qf(b)|0;break}}else{A=q}}while(0);n=o+1|0;if(n>>>0<3){q=A;o=n}else{y=A;z=n;break}}}else{y=u;z=v}}while(0);if((z|0)==0){do{if((y|0)==48){o=c[e>>2]|0;if(o>>>0<(c[m>>2]|0)>>>0){c[e>>2]=o+1;B=d[o]|0}else{B=Qf(b)|0}if((B|32|0)!=120){if((c[m>>2]|0)==0){C=48;break}c[e>>2]=(c[e>>2]|0)+ -1;C=48;break}o=c[e>>2]|0;if(o>>>0<(c[m>>2]|0)>>>0){c[e>>2]=o+1;E=d[o]|0;F=0}else{E=Qf(b)|0;F=0}while(1){if((E|0)==46){x=70;break}else if((E|0)!=48){G=0;H=0;I=0;J=0;K=E;L=F;M=0;N=0;P=1.0;Q=0;R=0.0;break}o=c[e>>2]|0;if(o>>>0<(c[m>>2]|0)>>>0){c[e>>2]=o+1;E=d[o]|0;F=1;continue}else{E=Qf(b)|0;F=1;continue}}b:do{if((x|0)==70){o=c[e>>2]|0;if(o>>>0<(c[m>>2]|0)>>>0){c[e>>2]=o+1;S=d[o]|0}else{S=Qf(b)|0}if((S|0)==48){o=-1;q=-1;while(1){n=c[e>>2]|0;if(n>>>0<(c[m>>2]|0)>>>0){c[e>>2]=n+1;T=d[n]|0}else{T=Qf(b)|0}if((T|0)!=48){G=0;H=0;I=o;J=q;K=T;L=1;M=1;N=0;P=1.0;Q=0;R=0.0;break b}n=_f(o|0,q|0,-1,-1)|0;o=n;q=D}}else{G=0;H=0;I=0;J=0;K=S;L=F;M=1;N=0;P=1.0;Q=0;R=0.0}}}while(0);c:while(1){q=K+ -48|0;do{if(!(q>>>0<10)){o=K|32;n=(K|0)==46;if(!((o+ -97|0)>>>0<6|n)){U=K;break c}if(n){if((M|0)==0){V=H;W=G;X=H;Y=G;Z=L;_=1;aa=N;ba=P;ca=Q;da=R;break}else{U=46;break c}}else{ea=(K|0)>57?o+ -87|0:q;x=84;break}}else{ea=q;x=84}}while(0);if((x|0)==84){x=0;do{if(!((G|0)<0|(G|0)==0&H>>>0<8)){if((G|0)<0|(G|0)==0&H>>>0<14){fa=P*.0625;ga=N;ha=fa;ia=Q;ja=R+fa*+(ea|0);break}if((ea|0)!=0&(N|0)==0){ga=1;ha=P;ia=Q;ja=R+P*.5}else{ga=N;ha=P;ia=Q;ja=R}}else{ga=N;ha=P;ia=ea+(Q<<4)|0;ja=R}}while(0);q=_f(H|0,G|0,1,0)|0;V=I;W=J;X=q;Y=D;Z=1;_=M;aa=ga;ba=ha;ca=ia;da=ja}q=c[e>>2]|0;if(q>>>0<(c[m>>2]|0)>>>0){c[e>>2]=q+1;G=Y;H=X;I=V;J=W;K=d[q]|0;L=Z;M=_;N=aa;P=ba;Q=ca;R=da;continue}else{G=Y;H=X;I=V;J=W;K=Qf(b)|0;L=Z;M=_;N=aa;P=ba;Q=ca;R=da;continue}}if((L|0)==0){q=(c[m>>2]|0)==0;if(!q){c[e>>2]=(c[e>>2]|0)+ -1}if(!w){if(!q?(q=c[e>>2]|0,c[e>>2]=q+ -1,(M|0)!=0):0){c[e>>2]=q+ -2}}else{Pf(b,0)}l=+(r|0)*0.0;i=g;return+l}q=(M|0)==0;o=q?H:I;n=q?G:J;if((G|0)<0|(G|0)==0&H>>>0<8){q=H;p=G;ka=Q;while(1){la=ka<<4;ma=_f(q|0,p|0,1,0)|0;na=D;if((na|0)<0|(na|0)==0&ma>>>0<8){q=ma;p=na;ka=la}else{oa=la;break}}}else{oa=Q}do{if((U|32|0)==112){ka=Of(b,f)|0;p=D;if((ka|0)==0&(p|0)==-2147483648){if(w){Pf(b,0);l=0.0;i=g;return+l}else{if((c[m>>2]|0)==0){pa=0;qa=0;break}c[e>>2]=(c[e>>2]|0)+ -1;pa=0;qa=0;break}}else{pa=ka;qa=p}}else{if((c[m>>2]|0)==0){pa=0;qa=0}else{c[e>>2]=(c[e>>2]|0)+ -1;pa=0;qa=0}}}while(0);p=gg(o|0,n|0,2)|0;ka=_f(p|0,D|0,-32,-1)|0;p=_f(ka|0,D|0,pa|0,qa|0)|0;ka=D;if((oa|0)==0){l=+(r|0)*0.0;i=g;return+l}if((ka|0)>0|(ka|0)==0&p>>>0>(0-k|0)>>>0){c[(Sa()|0)>>2]=34;l=+(r|0)*1.7976931348623157e+308*1.7976931348623157e+308;i=g;return+l}q=k+ -106|0;la=((q|0)<0)<<31>>31;if((ka|0)<(la|0)|(ka|0)==(la|0)&p>>>0<q>>>0){c[(Sa()|0)>>2]=34;l=+(r|0)*2.2250738585072014e-308*2.2250738585072014e-308;i=g;return+l}if((oa|0)>-1){q=p;la=ka;na=oa;fa=R;while(1){ma=na<<1;if(!(fa>=.5)){ra=fa;sa=ma}else{ra=fa+-1.0;sa=ma|1}ta=fa+ra;ma=_f(q|0,la|0,-1,-1)|0;ua=D;if((sa|0)>-1){q=ma;la=ua;na=sa;fa=ta}else{va=ma;wa=ua;xa=sa;ya=ta;break}}}else{va=p;wa=ka;xa=oa;ya=R}na=$f(32,0,k|0,((k|0)<0)<<31>>31|0)|0;la=_f(va|0,wa|0,na|0,D|0)|0;na=D;if(0>(na|0)|0==(na|0)&j>>>0>la>>>0){za=(la|0)<0?0:la}else{za=j}if((za|0)<53){fa=+(r|0);ta=+pb(+(+Rf(1.0,84-za|0)),+fa);if((za|0)<32&ya!=0.0){la=xa&1;Aa=fa;Ba=ta;Da=(la^1)+xa|0;Ea=(la|0)==0?0.0:ya}else{Aa=fa;Ba=ta;Da=xa;Ea=ya}}else{Aa=+(r|0);Ba=0.0;Da=xa;Ea=ya}ta=Aa*Ea+(Ba+Aa*+(Da>>>0))-Ba;if(!(ta!=0.0)){c[(Sa()|0)>>2]=34}l=+Sf(ta,va);i=g;return+l}else{C=y}}while(0);la=k+j|0;na=0-la|0;q=C;n=0;while(1){if((q|0)==46){x=139;break}else if((q|0)!=48){Fa=q;Ga=0;Ha=0;Ia=n;Ja=0;break}o=c[e>>2]|0;if(o>>>0<(c[m>>2]|0)>>>0){c[e>>2]=o+1;q=d[o]|0;n=1;continue}else{q=Qf(b)|0;n=1;continue}}d:do{if((x|0)==139){q=c[e>>2]|0;if(q>>>0<(c[m>>2]|0)>>>0){c[e>>2]=q+1;Ka=d[q]|0}else{Ka=Qf(b)|0}if((Ka|0)==48){q=-1;o=-1;while(1){ua=c[e>>2]|0;if(ua>>>0<(c[m>>2]|0)>>>0){c[e>>2]=ua+1;La=d[ua]|0}else{La=Qf(b)|0}if((La|0)!=48){Fa=La;Ga=q;Ha=o;Ia=1;Ja=1;break d}ua=_f(q|0,o|0,-1,-1)|0;q=ua;o=D}}else{Fa=Ka;Ga=0;Ha=0;Ia=n;Ja=1}}}while(0);c[h>>2]=0;n=Fa+ -48|0;o=(Fa|0)==46;e:do{if(n>>>0<10|o){q=h+496|0;ka=Fa;p=0;ua=0;ma=o;Ma=n;Na=Ga;Oa=Ha;Pa=Ia;Qa=Ja;Ra=0;Ta=0;Ua=0;while(1){do{if(ma){if((Qa|0)==0){Va=p;Wa=ua;Xa=p;Ya=ua;Za=Pa;_a=1;$a=Ra;ab=Ta;cb=Ua}else{db=ka;eb=Na;fb=Oa;gb=p;hb=ua;ib=Pa;jb=Ra;kb=Ta;lb=Ua;break e}}else{mb=_f(p|0,ua|0,1,0)|0;nb=D;ob=(ka|0)!=48;if((Ta|0)>=125){if(!ob){Va=Na;Wa=Oa;Xa=mb;Ya=nb;Za=Pa;_a=Qa;$a=Ra;ab=Ta;cb=Ua;break}c[q>>2]=c[q>>2]|1;Va=Na;Wa=Oa;Xa=mb;Ya=nb;Za=Pa;_a=Qa;$a=Ra;ab=Ta;cb=Ua;break}qb=h+(Ta<<2)|0;if((Ra|0)==0){rb=Ma}else{rb=ka+ -48+((c[qb>>2]|0)*10|0)|0}c[qb>>2]=rb;qb=Ra+1|0;sb=(qb|0)==9;Va=Na;Wa=Oa;Xa=mb;Ya=nb;Za=1;_a=Qa;$a=sb?0:qb;ab=(sb&1)+Ta|0;cb=ob?mb:Ua}}while(0);mb=c[e>>2]|0;if(mb>>>0<(c[m>>2]|0)>>>0){c[e>>2]=mb+1;tb=d[mb]|0}else{tb=Qf(b)|0}mb=tb+ -48|0;ob=(tb|0)==46;if(mb>>>0<10|ob){ka=tb;p=Xa;ua=Ya;ma=ob;Ma=mb;Na=Va;Oa=Wa;Pa=Za;Qa=_a;Ra=$a;Ta=ab;Ua=cb}else{ub=tb;vb=Xa;wb=Va;xb=Ya;yb=Wa;zb=Za;Ab=_a;Bb=$a;Cb=ab;Db=cb;x=162;break}}}else{ub=Fa;vb=0;wb=Ga;xb=0;yb=Ha;zb=Ia;Ab=Ja;Bb=0;Cb=0;Db=0;x=162}}while(0);if((x|0)==162){n=(Ab|0)==0;db=ub;eb=n?vb:wb;fb=n?xb:yb;gb=vb;hb=xb;ib=zb;jb=Bb;kb=Cb;lb=Db}n=(ib|0)!=0;if(n?(db|32|0)==101:0){o=Of(b,f)|0;Ua=D;do{if((o|0)==0&(Ua|0)==-2147483648){if(w){Pf(b,0);l=0.0;i=g;return+l}else{if((c[m>>2]|0)==0){Eb=0;Fb=0;break}c[e>>2]=(c[e>>2]|0)+ -1;Eb=0;Fb=0;break}}else{Eb=o;Fb=Ua}}while(0);Ua=_f(Eb|0,Fb|0,eb|0,fb|0)|0;Gb=Ua;Hb=D}else{if((db|0)>-1?(c[m>>2]|0)!=0:0){c[e>>2]=(c[e>>2]|0)+ -1;Gb=eb;Hb=fb}else{Gb=eb;Hb=fb}}if(!n){c[(Sa()|0)>>2]=22;Pf(b,0);l=0.0;i=g;return+l}Ua=c[h>>2]|0;if((Ua|0)==0){l=+(r|0)*0.0;i=g;return+l}do{if((Gb|0)==(gb|0)&(Hb|0)==(hb|0)&((hb|0)<0|(hb|0)==0&gb>>>0<10)){if(!(j>>>0>30)?(Ua>>>j|0)!=0:0){break}l=+(r|0)*+(Ua>>>0);i=g;return+l}}while(0);Ua=(k|0)/-2|0;n=((Ua|0)<0)<<31>>31;if((Hb|0)>(n|0)|(Hb|0)==(n|0)&Gb>>>0>Ua>>>0){c[(Sa()|0)>>2]=34;l=+(r|0)*1.7976931348623157e+308*1.7976931348623157e+308;i=g;return+l}Ua=k+ -106|0;n=((Ua|0)<0)<<31>>31;if((Hb|0)<(n|0)|(Hb|0)==(n|0)&Gb>>>0<Ua>>>0){c[(Sa()|0)>>2]=34;l=+(r|0)*2.2250738585072014e-308*2.2250738585072014e-308;i=g;return+l}if((jb|0)==0){Ib=kb}else{if((jb|0)<9){Ua=h+(kb<<2)|0;n=c[Ua>>2]|0;o=jb;do{n=n*10|0;o=o+1|0}while((o|0)!=9);c[Ua>>2]=n}Ib=kb+1|0}do{if((lb|0)<9?(lb|0)<=(Gb|0)&(Gb|0)<18:0){if((Gb|0)==9){l=+(r|0)*+((c[h>>2]|0)>>>0);i=g;return+l}if((Gb|0)<9){l=+(r|0)*+((c[h>>2]|0)>>>0)/+(c[4960+(8-Gb<<2)>>2]|0);i=g;return+l}o=j+27+($(Gb,-3)|0)|0;Ta=c[h>>2]|0;if((o|0)<=30?(Ta>>>o|0)!=0:0){break}l=+(r|0)*+(Ta>>>0)*+(c[4960+(Gb+ -10<<2)>>2]|0);i=g;return+l}}while(0);n=(Gb|0)%9|0;if((n|0)==0){Jb=0;Kb=0;Lb=Gb;Mb=Ib}else{Ua=(Gb|0)>-1?n:n+9|0;n=c[4960+(8-Ua<<2)>>2]|0;if((Ib|0)!=0){Ta=1e9/(n|0)|0;o=0;Ra=0;Qa=0;Pa=Gb;while(1){Oa=h+(Qa<<2)|0;Na=c[Oa>>2]|0;Ma=((Na>>>0)/(n>>>0)|0)+Ra|0;c[Oa>>2]=Ma;Ra=$((Na>>>0)%(n>>>0)|0,Ta)|0;Na=Qa;Qa=Qa+1|0;if((Na|0)==(o|0)&(Ma|0)==0){Nb=Qa&127;Ob=Pa+ -9|0}else{Nb=o;Ob=Pa}if((Qa|0)==(Ib|0)){break}else{o=Nb;Pa=Ob}}if((Ra|0)==0){Pb=Nb;Qb=Ob;Rb=Ib}else{c[h+(Ib<<2)>>2]=Ra;Pb=Nb;Qb=Ob;Rb=Ib+1|0}}else{Pb=0;Qb=Gb;Rb=0}Jb=Pb;Kb=0;Lb=9-Ua+Qb|0;Mb=Rb}f:while(1){Pa=h+(Jb<<2)|0;if((Lb|0)<18){o=Kb;Qa=Mb;while(1){Ta=0;n=Qa+127|0;Ma=Qa;while(1){Na=n&127;Oa=h+(Na<<2)|0;ma=gg(c[Oa>>2]|0,0,29)|0;ua=_f(ma|0,D|0,Ta|0,0)|0;ma=D;if(ma>>>0>0|(ma|0)==0&ua>>>0>1e9){p=qg(ua|0,ma|0,1e9,0)|0;ka=rg(ua|0,ma|0,1e9,0)|0;Sb=ka;Tb=p}else{Sb=ua;Tb=0}c[Oa>>2]=Sb;Oa=(Na|0)==(Jb|0);if((Na|0)!=(Ma+127&127|0)|Oa){Ub=Ma}else{Ub=(Sb|0)==0?Na:Ma}if(Oa){break}else{Ta=Tb;n=Na+ -1|0;Ma=Ub}}Ma=o+ -29|0;if((Tb|0)==0){o=Ma;Qa=Ub}else{Vb=Ma;Wb=Tb;Xb=Ub;break}}}else{if((Lb|0)==18){Yb=Kb;Zb=Mb}else{_b=Jb;$b=Kb;ac=Lb;bc=Mb;break}while(1){if(!((c[Pa>>2]|0)>>>0<9007199)){_b=Jb;$b=Yb;ac=18;bc=Zb;break f}Qa=0;o=Zb+127|0;Ma=Zb;while(1){n=o&127;Ta=h+(n<<2)|0;Na=gg(c[Ta>>2]|0,0,29)|0;Oa=_f(Na|0,D|0,Qa|0,0)|0;Na=D;if(Na>>>0>0|(Na|0)==0&Oa>>>0>1e9){ua=qg(Oa|0,Na|0,1e9,0)|0;p=rg(Oa|0,Na|0,1e9,0)|0;cc=p;dc=ua}else{cc=Oa;dc=0}c[Ta>>2]=cc;Ta=(n|0)==(Jb|0);if((n|0)!=(Ma+127&127|0)|Ta){ec=Ma}else{ec=(cc|0)==0?n:Ma}if(Ta){break}else{Qa=dc;o=n+ -1|0;Ma=ec}}Ma=Yb+ -29|0;if((dc|0)==0){Yb=Ma;Zb=ec}else{Vb=Ma;Wb=dc;Xb=ec;break}}}Pa=Jb+127&127;if((Pa|0)==(Xb|0)){Ma=Xb+127&127;o=h+((Xb+126&127)<<2)|0;c[o>>2]=c[o>>2]|c[h+(Ma<<2)>>2];fc=Ma}else{fc=Xb}c[h+(Pa<<2)>>2]=Wb;Jb=Pa;Kb=Vb;Lb=Lb+9|0;Mb=fc}g:while(1){gc=bc+1&127;Ua=h+((bc+127&127)<<2)|0;Ra=_b;Pa=$b;Ma=ac;while(1){o=(Ma|0)==18;Qa=(Ma|0)>27?9:1;hc=Ra;ic=Pa;while(1){n=0;while(1){Ta=n+hc&127;if((Ta|0)==(bc|0)){jc=2;break}Oa=c[h+(Ta<<2)>>2]|0;Ta=c[4952+(n<<2)>>2]|0;if(Oa>>>0<Ta>>>0){jc=2;break}ua=n+1|0;if(Oa>>>0>Ta>>>0){jc=n;break}if((ua|0)<2){n=ua}else{jc=ua;break}}if((jc|0)==2&o){break g}kc=Qa+ic|0;if((hc|0)==(bc|0)){hc=bc;ic=kc}else{break}}o=(1<<Qa)+ -1|0;n=1e9>>>Qa;lc=hc;mc=0;ua=hc;nc=Ma;do{Ta=h+(ua<<2)|0;Oa=c[Ta>>2]|0;p=(Oa>>>Qa)+mc|0;c[Ta>>2]=p;mc=$(Oa&o,n)|0;Oa=(ua|0)==(lc|0)&(p|0)==0;ua=ua+1&127;nc=Oa?nc+ -9|0:nc;lc=Oa?ua:lc}while((ua|0)!=(bc|0));if((mc|0)==0){Ra=lc;Pa=kc;Ma=nc;continue}if((gc|0)!=(lc|0)){break}c[Ua>>2]=c[Ua>>2]|1;Ra=lc;Pa=kc;Ma=nc}c[h+(bc<<2)>>2]=mc;_b=lc;$b=kc;ac=nc;bc=gc}Ma=hc&127;if((Ma|0)==(bc|0)){c[h+(gc+ -1<<2)>>2]=0;oc=gc}else{oc=bc}ta=+((c[h+(Ma<<2)>>2]|0)>>>0);Ma=hc+1&127;if((Ma|0)==(oc|0)){Pa=oc+1&127;c[h+(Pa+ -1<<2)>>2]=0;pc=Pa}else{pc=oc}fa=+(r|0);qc=fa*(ta*1.0e9+ +((c[h+(Ma<<2)>>2]|0)>>>0));Ma=ic+53|0;Pa=Ma-k|0;if((Pa|0)<(j|0)){rc=(Pa|0)<0?0:Pa;sc=1}else{rc=j;sc=0}if((rc|0)<53){ta=+pb(+(+Rf(1.0,105-rc|0)),+qc);tc=+Ca(+qc,+(+Rf(1.0,53-rc|0)));uc=ta;vc=tc;wc=ta+(qc-tc)}else{uc=0.0;vc=0.0;wc=qc}Ra=hc+2&127;if((Ra|0)!=(pc|0)){Ua=c[h+(Ra<<2)>>2]|0;do{if(!(Ua>>>0<5e8)){if(Ua>>>0>5e8){xc=fa*.75+vc;break}if((hc+3&127|0)==(pc|0)){xc=fa*.5+vc;break}else{xc=fa*.75+vc;break}}else{if((Ua|0)==0?(hc+3&127|0)==(pc|0):0){xc=vc;break}xc=fa*.25+vc}}while(0);if((53-rc|0)>1?!(+Ca(+xc,1.0)!=0.0):0){yc=xc+1.0}else{yc=xc}}else{yc=vc}fa=wc+yc-uc;do{if((Ma&2147483647|0)>(-2-la|0)){if(!(+O(+fa)>=9007199254740992.0)){zc=sc;Ac=ic;Bc=fa}else{zc=(sc|0)!=0&(rc|0)==(Pa|0)?0:sc;Ac=ic+1|0;Bc=fa*.5}if((Ac+50|0)<=(na|0)?!((zc|0)!=0&yc!=0.0):0){Cc=Ac;Dc=Bc;break}c[(Sa()|0)>>2]=34;Cc=Ac;Dc=Bc}else{Cc=ic;Dc=fa}}while(0);l=+Sf(Dc,Cc);i=g;return+l}else if((z|0)==3){na=c[e>>2]|0;if(na>>>0<(c[m>>2]|0)>>>0){c[e>>2]=na+1;Ec=d[na]|0}else{Ec=Qf(b)|0}if((Ec|0)==40){Fc=1}else{if((c[m>>2]|0)==0){l=s;i=g;return+l}c[e>>2]=(c[e>>2]|0)+ -1;l=s;i=g;return+l}while(1){na=c[e>>2]|0;if(na>>>0<(c[m>>2]|0)>>>0){c[e>>2]=na+1;Gc=d[na]|0}else{Gc=Qf(b)|0}if(!((Gc+ -48|0)>>>0<10|(Gc+ -65|0)>>>0<26)?!((Gc+ -97|0)>>>0<26|(Gc|0)==95):0){break}Fc=Fc+1|0}if((Gc|0)==41){l=s;i=g;return+l}na=(c[m>>2]|0)==0;if(!na){c[e>>2]=(c[e>>2]|0)+ -1}if(w){c[(Sa()|0)>>2]=22;Pf(b,0);l=0.0;i=g;return+l}if((Fc|0)==0|na){l=s;i=g;return+l}else{Hc=Fc}while(1){na=Hc+ -1|0;c[e>>2]=(c[e>>2]|0)+ -1;if((na|0)==0){l=s;break}else{Hc=na}}i=g;return+l}else{if((c[m>>2]|0)!=0){c[e>>2]=(c[e>>2]|0)+ -1}c[(Sa()|0)>>2]=22;Pf(b,0);l=0.0;i=g;return+l}}}while(0);if((x|0)==23){x=(c[m>>2]|0)==0;if(!x){c[e>>2]=(c[e>>2]|0)+ -1}if(!(v>>>0<4|(f|0)==0|x)){x=v;do{c[e>>2]=(c[e>>2]|0)+ -1;x=x+ -1|0}while(x>>>0>3)}}l=+(r|0)*t;i=g;return+l}function Of(a,b){a=a|0;b=b|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0;e=i;f=a+4|0;g=c[f>>2]|0;h=a+100|0;if(g>>>0<(c[h>>2]|0)>>>0){c[f>>2]=g+1;j=d[g]|0}else{j=Qf(a)|0}if((j|0)==43|(j|0)==45){g=(j|0)==45|0;k=c[f>>2]|0;if(k>>>0<(c[h>>2]|0)>>>0){c[f>>2]=k+1;l=d[k]|0}else{l=Qf(a)|0}if(!((l+ -48|0)>>>0<10|(b|0)==0)?(c[h>>2]|0)!=0:0){c[f>>2]=(c[f>>2]|0)+ -1;m=l;n=g}else{m=l;n=g}}else{m=j;n=0}if((m+ -48|0)>>>0>9){if((c[h>>2]|0)==0){o=-2147483648;p=0;D=o;i=e;return p|0}c[f>>2]=(c[f>>2]|0)+ -1;o=-2147483648;p=0;D=o;i=e;return p|0}else{q=m;r=0}while(1){s=q+ -48+r|0;m=c[f>>2]|0;if(m>>>0<(c[h>>2]|0)>>>0){c[f>>2]=m+1;t=d[m]|0}else{t=Qf(a)|0}if(!((t+ -48|0)>>>0<10&(s|0)<214748364)){break}q=t;r=s*10|0}r=((s|0)<0)<<31>>31;if((t+ -48|0)>>>0<10){q=s;m=r;j=t;while(1){g=pg(q|0,m|0,10,0)|0;l=D;b=_f(j|0,((j|0)<0)<<31>>31|0,-48,-1)|0;k=_f(b|0,D|0,g|0,l|0)|0;l=D;g=c[f>>2]|0;if(g>>>0<(c[h>>2]|0)>>>0){c[f>>2]=g+1;u=d[g]|0}else{u=Qf(a)|0}if((u+ -48|0)>>>0<10&((l|0)<21474836|(l|0)==21474836&k>>>0<2061584302)){q=k;m=l;j=u}else{v=k;w=l;x=u;break}}}else{v=s;w=r;x=t}if((x+ -48|0)>>>0<10){do{x=c[f>>2]|0;if(x>>>0<(c[h>>2]|0)>>>0){c[f>>2]=x+1;y=d[x]|0}else{y=Qf(a)|0}}while((y+ -48|0)>>>0<10)}if((c[h>>2]|0)!=0){c[f>>2]=(c[f>>2]|0)+ -1}f=(n|0)!=0;n=$f(0,0,v|0,w|0)|0;o=f?D:w;p=f?n:v;D=o;i=e;return p|0}function Pf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0;d=i;c[a+104>>2]=b;e=c[a+8>>2]|0;f=c[a+4>>2]|0;g=e-f|0;c[a+108>>2]=g;if((b|0)!=0&(g|0)>(b|0)){c[a+100>>2]=f+b;i=d;return}else{c[a+100>>2]=e;i=d;return}}function Qf(b){b=b|0;var e=0,f=0,g=0,h=0,j=0,k=0,l=0;e=i;f=b+104|0;g=c[f>>2]|0;if(!((g|0)!=0?(c[b+108>>2]|0)>=(g|0):0)){h=3}if((h|0)==3?(h=Uf(b)|0,(h|0)>=0):0){g=c[f>>2]|0;f=c[b+8>>2]|0;if((g|0)!=0?(j=c[b+4>>2]|0,k=g-(c[b+108>>2]|0)+ -1|0,(f-j|0)>(k|0)):0){c[b+100>>2]=j+k}else{c[b+100>>2]=f}k=c[b+4>>2]|0;if((f|0)!=0){j=b+108|0;c[j>>2]=f+1-k+(c[j>>2]|0)}j=k+ -1|0;if((d[j]|0|0)==(h|0)){l=h;i=e;return l|0}a[j]=h;l=h;i=e;return l|0}c[b+100>>2]=0;l=-1;i=e;return l|0}function Rf(a,b){a=+a;b=b|0;var d=0,e=0.0,f=0,g=0,j=0,l=0.0;d=i;if((b|0)>1023){e=a*8.98846567431158e+307;f=b+ -1023|0;if((f|0)>1023){g=b+ -2046|0;j=(g|0)>1023?1023:g;l=e*8.98846567431158e+307}else{j=f;l=e}}else{if((b|0)<-1022){e=a*2.2250738585072014e-308;f=b+1022|0;if((f|0)<-1022){g=b+2044|0;j=(g|0)<-1022?-1022:g;l=e*2.2250738585072014e-308}else{j=f;l=e}}else{j=b;l=a}}b=gg(j+1023|0,0,52)|0;j=D;c[k>>2]=b;c[k+4>>2]=j;a=l*+h[k>>3];i=d;return+a}function Sf(a,b){a=+a;b=b|0;var c=0,d=0.0;c=i;d=+Rf(a,b);i=c;return+d}function Tf(b){b=b|0;var d=0,e=0,f=0,g=0,h=0;d=i;e=b+74|0;f=a[e]|0;a[e]=f+255|f;f=b+20|0;e=b+44|0;if((c[f>>2]|0)>>>0>(c[e>>2]|0)>>>0){Pb[c[b+36>>2]&7](b,0,0)|0}c[b+16>>2]=0;c[b+28>>2]=0;c[f>>2]=0;f=c[b>>2]|0;if((f&20|0)==0){g=c[e>>2]|0;c[b+8>>2]=g;c[b+4>>2]=g;h=0;i=d;return h|0}if((f&4|0)==0){h=-1;i=d;return h|0}c[b>>2]=f|32;h=-1;i=d;return h|0}function Uf(a){a=a|0;var b=0,e=0,f=0;b=i;i=i+16|0;e=b;if((c[a+8>>2]|0)==0?(Tf(a)|0)!=0:0){f=-1}else{if((Pb[c[a+32>>2]&7](a,e,1)|0)==1){f=d[e]|0}else{f=-1}}i=b;return f|0}function Vf(a){a=a|0;var b=0,c=0.0;b=i;c=+Xf(a,0);i=b;return+c}function Wf(b){b=b|0;var c=0,d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0;c=i;d=b;while(1){e=d+1|0;if((bb(a[d]|0)|0)==0){break}else{d=e}}b=a[d]|0;f=b<<24>>24;if((f|0)==45){g=1;h=5}else if((f|0)==43){g=0;h=5}else{j=d;k=b;l=0}if((h|0)==5){j=e;k=a[e]|0;l=g}if((wb(k<<24>>24|0)|0)==0){m=0;n=(l|0)!=0;o=0-m|0;p=n?m:o;i=c;return p|0}else{q=j;r=0}while(1){j=q+1|0;k=(r*10|0)+48-(a[q]|0)|0;if((wb(a[j]|0)|0)==0){m=k;break}else{q=j;r=k}}n=(l|0)!=0;o=0-m|0;p=n?m:o;i=c;return p|0}function Xf(a,b){a=a|0;b=b|0;var d=0,e=0,f=0,g=0,h=0.0,j=0,k=0;d=i;i=i+112|0;e=d;f=e+0|0;g=f+112|0;do{c[f>>2]=0;f=f+4|0}while((f|0)<(g|0));f=e+4|0;c[f>>2]=a;g=e+8|0;c[g>>2]=-1;c[e+44>>2]=a;c[e+76>>2]=-1;Pf(e,0);h=+Nf(e,1,1);j=(c[f>>2]|0)-(c[g>>2]|0)+(c[e+108>>2]|0)|0;if((b|0)==0){i=d;return+h}if((j|0)==0){k=a}else{k=a+j|0}c[b>>2]=k;i=d;return+h}function Yf(b,c){b=b|0;c=c|0;var d=0,e=0,f=0,g=0,h=0,j=0,k=0,l=0,m=0,n=0;d=i;e=a[b]|0;f=a[c]|0;if(e<<24>>24!=f<<24>>24|e<<24>>24==0|f<<24>>24==0){g=e;h=f;j=g&255;k=h&255;l=j-k|0;i=d;return l|0}else{m=b;n=c}while(1){c=m+1|0;b=n+1|0;f=a[c]|0;e=a[b]|0;if(f<<24>>24!=e<<24>>24|f<<24>>24==0|e<<24>>24==0){g=f;h=e;break}else{m=c;n=b}}j=g&255;k=h&255;l=j-k|0;i=d;return l|0}function Zf(){}function _f(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;var e=0;e=a+c>>>0;return(D=b+d+(e>>>0<a>>>0|0)>>>0,e|0)|0}function $f(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;var e=0;e=b-d>>>0;e=b-d-(c>>>0>a>>>0|0)>>>0;return(D=e,a-c>>>0|0)|0}function ag(b,c,d){b=b|0;c=c|0;d=d|0;var e=0,f=0;while((e|0)<(d|0)){a[b+e|0]=f?0:a[c+e|0]|0;f=f?1:(a[c+e|0]|0)==0;e=e+1|0}return b|0}function bg(b,d,e){b=b|0;d=d|0;e=e|0;var f=0;if((e|0)>=4096)return Ta(b|0,d|0,e|0)|0;f=b|0;if((b&3)==(d&3)){while(b&3){if((e|0)==0)return f|0;a[b]=a[d]|0;b=b+1|0;d=d+1|0;e=e-1|0}while((e|0)>=4){c[b>>2]=c[d>>2];b=b+4|0;d=d+4|0;e=e-4|0}}while((e|0)>0){a[b]=a[d]|0;b=b+1|0;d=d+1|0;e=e-1|0}return f|0}function cg(b,c,d){b=b|0;c=c|0;d=d|0;var e=0;if((c|0)<(b|0)&(b|0)<(c+d|0)){e=b;c=c+d|0;b=b+d|0;while((d|0)>0){b=b-1|0;c=c-1|0;d=d-1|0;a[b]=a[c]|0}b=e}else{bg(b,c,d)|0}return b|0}function dg(b){b=b|0;var c=0;c=b;while(a[c]|0){c=c+1|0}return c-b|0}function eg(b,d,e){b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,i=0;f=b+e|0;if((e|0)>=20){d=d&255;g=b&3;h=d|d<<8|d<<16|d<<24;i=f&~3;if(g){g=b+4-g|0;while((b|0)<(g|0)){a[b]=d;b=b+1|0}}while((b|0)<(i|0)){c[b>>2]=h;b=b+4|0}}while((b|0)<(f|0)){a[b]=d;b=b+1|0}return b-e|0}function fg(b,c){b=b|0;c=c|0;var d=0,e=0;d=b+(dg(b)|0)|0;do{a[d+e|0]=a[c+e|0];e=e+1|0}while(a[c+(e-1)|0]|0);return b|0}function gg(a,b,c){a=a|0;b=b|0;c=c|0;if((c|0)<32){D=b<<c|(a&(1<<c)-1<<32-c)>>>32-c;return a<<c}D=a<<c-32;return 0}function hg(b,c){b=b|0;c=c|0;var d=0;do{a[b+d|0]=a[c+d|0];d=d+1|0}while(a[c+(d-1)|0]|0);return b|0}function ig(a,b,c){a=a|0;b=b|0;c=c|0;if((c|0)<32){D=b>>>c;return a>>>c|(b&(1<<c)-1)<<32-c}D=0;return b>>>c-32|0}function jg(a,b,c){a=a|0;b=b|0;c=c|0;if((c|0)<32){D=b>>c;return a>>>c|(b&(1<<c)-1)<<32-c}D=(b|0)<0?-1:0;return b>>c-32|0}function kg(b){b=b|0;var c=0;c=a[n+(b>>>24)|0]|0;if((c|0)<8)return c|0;c=a[n+(b>>16&255)|0]|0;if((c|0)<8)return c+8|0;c=a[n+(b>>8&255)|0]|0;if((c|0)<8)return c+16|0;return(a[n+(b&255)|0]|0)+24|0}function lg(b){b=b|0;var c=0;c=a[m+(b&255)|0]|0;if((c|0)<8)return c|0;c=a[m+(b>>8&255)|0]|0;if((c|0)<8)return c+8|0;c=a[m+(b>>16&255)|0]|0;if((c|0)<8)return c+16|0;return(a[m+(b>>>24)|0]|0)+24|0}function mg(a,b){a=a|0;b=b|0;var c=0,d=0,e=0,f=0;c=a&65535;d=b&65535;e=$(d,c)|0;f=a>>>16;a=(e>>>16)+($(d,f)|0)|0;d=b>>>16;b=$(d,c)|0;return(D=(a>>>16)+($(d,f)|0)+(((a&65535)+b|0)>>>16)|0,a+b<<16|e&65535|0)|0}function ng(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;var e=0,f=0,g=0,h=0,i=0;e=b>>31|((b|0)<0?-1:0)<<1;f=((b|0)<0?-1:0)>>31|((b|0)<0?-1:0)<<1;g=d>>31|((d|0)<0?-1:0)<<1;h=((d|0)<0?-1:0)>>31|((d|0)<0?-1:0)<<1;i=$f(e^a,f^b,e,f)|0;b=D;a=g^e;e=h^f;f=$f((sg(i,b,$f(g^c,h^d,g,h)|0,D,0)|0)^a,D^e,a,e)|0;return f|0}function og(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0,h=0,j=0,k=0,l=0,m=0;f=i;i=i+8|0;g=f|0;h=b>>31|((b|0)<0?-1:0)<<1;j=((b|0)<0?-1:0)>>31|((b|0)<0?-1:0)<<1;k=e>>31|((e|0)<0?-1:0)<<1;l=((e|0)<0?-1:0)>>31|((e|0)<0?-1:0)<<1;m=$f(h^a,j^b,h,j)|0;b=D;sg(m,b,$f(k^d,l^e,k,l)|0,D,g)|0;l=$f(c[g>>2]^h,c[g+4>>2]^j,h,j)|0;j=D;i=f;return(D=j,l)|0}function pg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;var e=0,f=0;e=a;a=c;c=mg(e,a)|0;f=D;return(D=($(b,a)|0)+($(d,e)|0)+f|f&0,c|0|0)|0}function qg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;var e=0;e=sg(a,b,c,d,0)|0;return e|0}function rg(a,b,d,e){a=a|0;b=b|0;d=d|0;e=e|0;var f=0,g=0;f=i;i=i+8|0;g=f|0;sg(a,b,d,e,g)|0;i=f;return(D=c[g+4>>2]|0,c[g>>2]|0)|0}function sg(a,b,d,e,f){a=a|0;b=b|0;d=d|0;e=e|0;f=f|0;var g=0,h=0,i=0,j=0,k=0,l=0,m=0,n=0,o=0,p=0,q=0,r=0,s=0,t=0,u=0,v=0,w=0,x=0,y=0,z=0,A=0,B=0,C=0,E=0,F=0,G=0,H=0;g=a;h=b;i=h;j=d;k=e;l=k;if((i|0)==0){m=(f|0)!=0;if((l|0)==0){if(m){c[f>>2]=(g>>>0)%(j>>>0);c[f+4>>2]=0}n=0;o=(g>>>0)/(j>>>0)>>>0;return(D=n,o)|0}else{if(!m){n=0;o=0;return(D=n,o)|0}c[f>>2]=a|0;c[f+4>>2]=b&0;n=0;o=0;return(D=n,o)|0}}m=(l|0)==0;do{if((j|0)!=0){if(!m){p=(kg(l|0)|0)-(kg(i|0)|0)|0;if(p>>>0<=31){q=p+1|0;r=31-p|0;s=p-31>>31;t=q;u=g>>>(q>>>0)&s|i<<r;v=i>>>(q>>>0)&s;w=0;x=g<<r;break}if((f|0)==0){n=0;o=0;return(D=n,o)|0}c[f>>2]=a|0;c[f+4>>2]=h|b&0;n=0;o=0;return(D=n,o)|0}r=j-1|0;if((r&j|0)!=0){s=(kg(j|0)|0)+33-(kg(i|0)|0)|0;q=64-s|0;p=32-s|0;y=p>>31;z=s-32|0;A=z>>31;t=s;u=p-1>>31&i>>>(z>>>0)|(i<<p|g>>>(s>>>0))&A;v=A&i>>>(s>>>0);w=g<<q&y;x=(i<<q|g>>>(z>>>0))&y|g<<p&s-33>>31;break}if((f|0)!=0){c[f>>2]=r&g;c[f+4>>2]=0}if((j|0)==1){n=h|b&0;o=a|0|0;return(D=n,o)|0}else{r=lg(j|0)|0;n=i>>>(r>>>0)|0;o=i<<32-r|g>>>(r>>>0)|0;return(D=n,o)|0}}else{if(m){if((f|0)!=0){c[f>>2]=(i>>>0)%(j>>>0);c[f+4>>2]=0}n=0;o=(i>>>0)/(j>>>0)>>>0;return(D=n,o)|0}if((g|0)==0){if((f|0)!=0){c[f>>2]=0;c[f+4>>2]=(i>>>0)%(l>>>0)}n=0;o=(i>>>0)/(l>>>0)>>>0;return(D=n,o)|0}r=l-1|0;if((r&l|0)==0){if((f|0)!=0){c[f>>2]=a|0;c[f+4>>2]=r&i|b&0}n=0;o=i>>>((lg(l|0)|0)>>>0);return(D=n,o)|0}r=(kg(l|0)|0)-(kg(i|0)|0)|0;if(r>>>0<=30){s=r+1|0;p=31-r|0;t=s;u=i<<p|g>>>(s>>>0);v=i>>>(s>>>0);w=0;x=g<<p;break}if((f|0)==0){n=0;o=0;return(D=n,o)|0}c[f>>2]=a|0;c[f+4>>2]=h|b&0;n=0;o=0;return(D=n,o)|0}}while(0);if((t|0)==0){B=x;C=w;E=v;F=u;G=0;H=0}else{b=d|0|0;d=k|e&0;e=_f(b,d,-1,-1)|0;k=D;h=x;x=w;w=v;v=u;u=t;t=0;do{a=h;h=x>>>31|h<<1;x=t|x<<1;g=v<<1|a>>>31|0;a=v>>>31|w<<1|0;$f(e,k,g,a)|0;i=D;l=i>>31|((i|0)<0?-1:0)<<1;t=l&1;v=$f(g,a,l&b,(((i|0)<0?-1:0)>>31|((i|0)<0?-1:0)<<1)&d)|0;w=D;u=u-1|0}while((u|0)!=0);B=h;C=x;E=w;F=v;G=0;H=t}t=C;C=0;if((f|0)!=0){c[f>>2]=F;c[f+4>>2]=E}n=(t|0)>>>31|(B|C)<<1|(C<<1|t>>>31)&0|G;o=(t<<1|0>>>31)&-2|H;return(D=n,o)|0}function tg(a,b,c,d,e){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;return Gb[a&3](b|0,c|0,d|0,e|0)|0}function ug(a,b,c,d,e,f){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;Hb[a&3](b|0,c|0,d|0,e|0,f|0)}function vg(a){a=a|0;return Ib[a&1]()|0}function wg(a,b){a=a|0;b=b|0;Jb[a&7](b|0)}function xg(a,b,c){a=a|0;b=b|0;c=c|0;Kb[a&7](b|0,c|0)}function yg(a,b,c,d,e,f,g){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=g|0;return Lb[a&1](b|0,c|0,d|0,e|0,f|0,g|0)|0}function zg(a,b,c,d,e,f,g,h){a=a|0;b=b|0;c=+c;d=+d;e=+e;f=+f;g=+g;h=h|0;Mb[a&1](b|0,+c,+d,+e,+f,+g,h|0)}function Ag(a,b,c,d,e,f,g,h,i){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=g|0;h=+h;i=+i;Nb[a&1](b|0,c|0,d|0,e|0,f|0,g|0,+h,+i)}function Bg(a,b){a=a|0;b=b|0;return Ob[a&15](b|0)|0}function Cg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;return Pb[a&7](b|0,c|0,d|0)|0}function Dg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;Qb[a&7](b|0,c|0,d|0)}function Eg(a,b,c,d,e,f,g,h,i){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;i=i|0;Rb[a&1](b|0,c|0,d|0,e|0,f|0,g|0,h|0,i|0)}function Fg(a,b,c,d,e,f,g){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=g|0;Sb[a&3](b|0,c|0,d|0,e|0,f|0,g|0)}function Gg(a,b,c){a=a|0;b=b|0;c=c|0;return Tb[a&15](b|0,c|0)|0}function Hg(a,b,c,d,e){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;return+Ub[a&3](b|0,c|0,d|0,e|0)}function Ig(a,b,c,d,e){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;Vb[a&7](b|0,c|0,d|0,e|0)}function Jg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;aa(0);return 0}function Kg(a,b,c,d,e){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;aa(1)}function Lg(){aa(2);return 0}function Mg(a){a=a|0;aa(3)}function Ng(a,b){a=a|0;b=b|0;aa(4)}function Og(a,b,c,d,e,f){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;aa(5);return 0}function Pg(a,b,c,d,e,f,g){a=a|0;b=+b;c=+c;d=+d;e=+e;f=+f;g=g|0;aa(6)}function Qg(a,b,c,d,e,f,g,h){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=+g;h=+h;aa(7)}function Rg(a){a=a|0;aa(8);return 0}function Sg(a,b,c){a=a|0;b=b|0;c=c|0;aa(9);return 0}function Tg(a,b,c){a=a|0;b=b|0;c=c|0;aa(10)}function Ug(a,b,c,d,e,f,g,h){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;g=g|0;h=h|0;aa(11)}function Vg(a,b,c,d,e,f){a=a|0;b=b|0;c=c|0;d=d|0;e=e|0;f=f|0;aa(12)}function Wg(a,b){a=a|0;b=b|0;aa(13);return 0}function Xg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;aa(14);return 0.0}function Yg(a,b,c,d){a=a|0;b=b|0;c=c|0;d=d|0;aa(15)}




// EMSCRIPTEN_END_FUNCS
    var Gb=[Jg,Cd,Hd,Jg];var Hb=[Kg,Rc,Tc,Uc];var Ib=[Lg,td];var Jb=[Mg,Vc,Wc,Xc,xd,Gd,Ld,qd];var Kb=[Ng,Yc,_c,vd,Nd,Vd,Ng,Ng];var Lb=[Og,Pd];var Mb=[Pg,cd];var Nb=[Qg,Wd];var Ob=[Rg,yd,zd,Ad,Fd,Id,Jd,Kd,Md,Zd,Rg,Rg,Rg,Rg,Rg,Rg];var Pb=[Sg,Zc,bd,ud,Ed,od,hf,jf];var Qb=[Tg,Od,_d,$d,ld,Be,Tg,Tg];var Rb=[Ug,Oc];var Sb=[Vg,Pc,Qc,Sc];var Tb=[Wg,wd,Bd,Dd,Qd,Td,Ud,ae,ge,Wg,Wg,Wg,Wg,Wg,Wg,Wg];var Ub=[Xg,Xd,Yd,Xg];var Vb=[Yg,$c,ad,Rd,Sd,Yg,Yg,Yg];return{_strlen:dg,_strcat:fg,_resize_puzzle:Fc,_dlg_return_sval:fd,_timer_callback:Ec,_get_save_file:kd,_load_game:nd,_main:pd,_strncpy:ag,_memset:eg,_dlg_return_ival:gd,_memcpy:bg,_mousemove:Mc,_bitshift64Shl:gg,_i64Subtract:$f,_realloc:Kf,_i64Add:_f,_free_save_file:md,_command:hd,_restore_puzzle_size:Gc,_free:Jf,_key:Nc,_memmove:cg,_mousedown:Jc,_malloc:If,_mouseup:Lc,_strcpy:hg,runPostSets:Zf,stackAlloc:Wb,stackSave:Xb,stackRestore:Yb,setThrew:Zb,setTempRet0:ac,setTempRet1:bc,setTempRet2:cc,setTempRet3:dc,setTempRet4:ec,setTempRet5:fc,setTempRet6:gc,setTempRet7:hc,setTempRet8:ic,setTempRet9:jc,dynCall_iiiii:tg,dynCall_viiiii:ug,dynCall_i:vg,dynCall_vi:wg,dynCall_vii:xg,dynCall_iiiiiii:yg,dynCall_vidddddi:zg,dynCall_viiiiiidd:Ag,dynCall_ii:Bg,dynCall_iiii:Cg,dynCall_viii:Dg,dynCall_viiiiiiii:Eg,dynCall_viiiiii:Fg,dynCall_iii:Gg,dynCall_diiii:Hg,dynCall_viiii:Ig}})


// EMSCRIPTEN_END_ASM
({ "Math": Math, "Int8Array": Int8Array, "Int16Array": Int16Array, "Int32Array": Int32Array, "Uint8Array": Uint8Array, "Uint16Array": Uint16Array, "Uint32Array": Uint32Array, "Float32Array": Float32Array, "Float64Array": Float64Array }, { "abort": abort, "assert": assert, "asmPrintInt": asmPrintInt, "asmPrintFloat": asmPrintFloat, "min": Math_min, "invoke_iiiii": invoke_iiiii, "invoke_viiiii": invoke_viiiii, "invoke_i": invoke_i, "invoke_vi": invoke_vi, "invoke_vii": invoke_vii, "invoke_iiiiiii": invoke_iiiiiii, "invoke_vidddddi": invoke_vidddddi, "invoke_viiiiiidd": invoke_viiiiiidd, "invoke_ii": invoke_ii, "invoke_iiii": invoke_iiii, "invoke_viii": invoke_viii, "invoke_viiiiiiii": invoke_viiiiiiii, "invoke_viiiiii": invoke_viiiiii, "invoke_iii": invoke_iii, "invoke_diiii": invoke_diiii, "invoke_viiii": invoke_viiii, "_fabs": _fabs, "_js_add_preset_submenu": _js_add_preset_submenu, "_js_error_box": _js_error_box, "_js_dialog_cleanup": _js_dialog_cleanup, "_js_select_preset": _js_select_preset, "_js_dialog_init": _js_dialog_init, "_js_canvas_draw_line": _js_canvas_draw_line, "_fmod": _fmod, "_atan2": _atan2, "__reallyNegative": __reallyNegative, "_js_canvas_find_font_midpoint": _js_canvas_find_font_midpoint, "___assert_fail": ___assert_fail, "___buildEnvironment": ___buildEnvironment, "_js_focus_canvas": _js_focus_canvas, "_js_canvas_set_size": _js_canvas_set_size, "_js_dialog_launch": _js_dialog_launch, "_js_canvas_draw_circle": _js_canvas_draw_circle, "_js_canvas_draw_rect": _js_canvas_draw_rect, "_sscanf": _sscanf, "_sbrk": _sbrk, "_js_dialog_boolean": _js_dialog_boolean, "_js_canvas_new_blitter": _js_canvas_new_blitter, "_snprintf": _snprintf, "___errno_location": ___errno_location, "_emscripten_memcpy_big": _emscripten_memcpy_big, "_js_canvas_make_statusbar": _js_canvas_make_statusbar, "_js_canvas_set_statusbar": _js_canvas_set_statusbar, "_sysconf": _sysconf, "_js_canvas_unclip": _js_canvas_unclip, "___setErrNo": ___setErrNo, "_js_canvas_draw_text": _js_canvas_draw_text, "_js_dialog_string": _js_dialog_string, "_js_canvas_draw_update": _js_canvas_draw_update, "_js_update_permalinks": _js_update_permalinks, "_isspace": _isspace, "_js_activate_timer": _js_activate_timer, "_js_remove_solve_button": _js_remove_solve_button, "_getenv": _getenv, "_sprintf": _sprintf, "_js_canvas_start_draw": _js_canvas_start_draw, "_js_add_preset": _js_add_preset, "_toupper": _toupper, "_js_get_date_64": _js_get_date_64, "_fflush": _fflush, "__scanString": __scanString, "_js_deactivate_timer": _js_deactivate_timer, "_vsnprintf": _vsnprintf, "_js_canvas_copy_from_blitter": _js_canvas_copy_from_blitter, "_copysign": _copysign, "_js_canvas_end_draw": _js_canvas_end_draw, "__getFloat": __getFloat, "_abort": _abort, "_js_dialog_choices": _js_dialog_choices, "_js_canvas_copy_to_blitter": _js_canvas_copy_to_blitter, "_time": _time, "_isdigit": _isdigit, "_js_enable_undo_redo": _js_enable_undo_redo, "_abs": _abs, "__formatString": __formatString, "_js_canvas_clip_rect": _js_canvas_clip_rect, "_sqrt": _sqrt, "_js_canvas_draw_poly": _js_canvas_draw_poly, "_js_canvas_free_blitter": _js_canvas_free_blitter, "_js_get_selected_preset": _js_get_selected_preset, "STACKTOP": STACKTOP, "STACK_MAX": STACK_MAX, "tempDoublePtr": tempDoublePtr, "ABORT": ABORT, "cttz_i8": cttz_i8, "ctlz_i8": ctlz_i8, "NaN": NaN, "Infinity": Infinity }, buffer);
var _strlen = Module["_strlen"] = asm["_strlen"];
var _strcat = Module["_strcat"] = asm["_strcat"];
var _resize_puzzle = Module["_resize_puzzle"] = asm["_resize_puzzle"];
var _dlg_return_sval = Module["_dlg_return_sval"] = asm["_dlg_return_sval"];
var _timer_callback = Module["_timer_callback"] = asm["_timer_callback"];
var _get_save_file = Module["_get_save_file"] = asm["_get_save_file"];
var _load_game = Module["_load_game"] = asm["_load_game"];
var _main = Module["_main"] = asm["_main"];
var _strncpy = Module["_strncpy"] = asm["_strncpy"];
var _memset = Module["_memset"] = asm["_memset"];
var _dlg_return_ival = Module["_dlg_return_ival"] = asm["_dlg_return_ival"];
var _memcpy = Module["_memcpy"] = asm["_memcpy"];
var _mousemove = Module["_mousemove"] = asm["_mousemove"];
var _bitshift64Shl = Module["_bitshift64Shl"] = asm["_bitshift64Shl"];
var _i64Subtract = Module["_i64Subtract"] = asm["_i64Subtract"];
var _realloc = Module["_realloc"] = asm["_realloc"];
var _i64Add = Module["_i64Add"] = asm["_i64Add"];
var _free_save_file = Module["_free_save_file"] = asm["_free_save_file"];
var _command = Module["_command"] = asm["_command"];
var _restore_puzzle_size = Module["_restore_puzzle_size"] = asm["_restore_puzzle_size"];
var _free = Module["_free"] = asm["_free"];
var _key = Module["_key"] = asm["_key"];
var _memmove = Module["_memmove"] = asm["_memmove"];
var _mousedown = Module["_mousedown"] = asm["_mousedown"];
var _malloc = Module["_malloc"] = asm["_malloc"];
var _mouseup = Module["_mouseup"] = asm["_mouseup"];
var _strcpy = Module["_strcpy"] = asm["_strcpy"];
var runPostSets = Module["runPostSets"] = asm["runPostSets"];
var dynCall_iiiii = Module["dynCall_iiiii"] = asm["dynCall_iiiii"];
var dynCall_viiiii = Module["dynCall_viiiii"] = asm["dynCall_viiiii"];
var dynCall_i = Module["dynCall_i"] = asm["dynCall_i"];
var dynCall_vi = Module["dynCall_vi"] = asm["dynCall_vi"];
var dynCall_vii = Module["dynCall_vii"] = asm["dynCall_vii"];
var dynCall_iiiiiii = Module["dynCall_iiiiiii"] = asm["dynCall_iiiiiii"];
var dynCall_vidddddi = Module["dynCall_vidddddi"] = asm["dynCall_vidddddi"];
var dynCall_viiiiiidd = Module["dynCall_viiiiiidd"] = asm["dynCall_viiiiiidd"];
var dynCall_ii = Module["dynCall_ii"] = asm["dynCall_ii"];
var dynCall_iiii = Module["dynCall_iiii"] = asm["dynCall_iiii"];
var dynCall_viii = Module["dynCall_viii"] = asm["dynCall_viii"];
var dynCall_viiiiiiii = Module["dynCall_viiiiiiii"] = asm["dynCall_viiiiiiii"];
var dynCall_viiiiii = Module["dynCall_viiiiii"] = asm["dynCall_viiiiii"];
var dynCall_iii = Module["dynCall_iii"] = asm["dynCall_iii"];
var dynCall_diiii = Module["dynCall_diiii"] = asm["dynCall_diiii"];
var dynCall_viiii = Module["dynCall_viiii"] = asm["dynCall_viiii"];

Runtime.stackAlloc = function(size) { return asm['stackAlloc'](size) };
Runtime.stackSave = function() { return asm['stackSave']() };
Runtime.stackRestore = function(top) { asm['stackRestore'](top) };


// TODO: strip out parts of this we do not need

//======= begin closure i64 code =======

// Copyright 2009 The Closure Library Authors. All Rights Reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS-IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * @fileoverview Defines a Long class for representing a 64-bit two's-complement
 * integer value, which faithfully simulates the behavior of a Java "long". This
 * implementation is derived from LongLib in GWT.
 *
 */

var i64Math = (function() { // Emscripten wrapper
    var goog = { math: {} };


    /**
     * Constructs a 64-bit two's-complement integer, given its low and high 32-bit
     * values as *signed* integers.  See the from* functions below for more
     * convenient ways of constructing Longs.
     *
     * The internal representation of a long is the two given signed, 32-bit values.
     * We use 32-bit pieces because these are the size of integers on which
     * Javascript performs bit-operations.  For operations like addition and
     * multiplication, we split each number into 16-bit pieces, which can easily be
     * multiplied within Javascript's floating-point representation without overflow
     * or change in sign.
     *
     * In the algorithms below, we frequently reduce the negative case to the
     * positive case by negating the input(s) and then post-processing the result.
     * Note that we must ALWAYS check specially whether those values are MIN_VALUE
     * (-2^63) because -MIN_VALUE == MIN_VALUE (since 2^63 cannot be represented as
     * a positive number, it overflows back into a negative).  Not handling this
     * case would often result in infinite recursion.
     *
     * @param {number} low  The low (signed) 32 bits of the long.
     * @param {number} high  The high (signed) 32 bits of the long.
     * @constructor
     */
    goog.math.Long = function(low, high) {
        /**
         * @type {number}
         * @private
         */
        this.low_ = low | 0;  // force into 32 signed bits.

        /**
         * @type {number}
         * @private
         */
        this.high_ = high | 0;  // force into 32 signed bits.
    };


    // NOTE: Common constant values ZERO, ONE, NEG_ONE, etc. are defined below the
    // from* methods on which they depend.


    /**
     * A cache of the Long representations of small integer values.
     * @type {!Object}
     * @private
     */
    goog.math.Long.IntCache_ = {};


    /**
     * Returns a Long representing the given (32-bit) integer value.
     * @param {number} value The 32-bit integer in question.
     * @return {!goog.math.Long} The corresponding Long value.
     */
    goog.math.Long.fromInt = function(value) {
        if (-128 <= value && value < 128) {
            var cachedObj = goog.math.Long.IntCache_[value];
            if (cachedObj) {
                return cachedObj;
            }
        }

        var obj = new goog.math.Long(value | 0, value < 0 ? -1 : 0);
        if (-128 <= value && value < 128) {
            goog.math.Long.IntCache_[value] = obj;
        }
        return obj;
    };


    /**
     * Returns a Long representing the given value, provided that it is a finite
     * number.  Otherwise, zero is returned.
     * @param {number} value The number in question.
     * @return {!goog.math.Long} The corresponding Long value.
     */
    goog.math.Long.fromNumber = function(value) {
        if (isNaN(value) || !isFinite(value)) {
            return goog.math.Long.ZERO;
        } else if (value <= -goog.math.Long.TWO_PWR_63_DBL_) {
            return goog.math.Long.MIN_VALUE;
        } else if (value + 1 >= goog.math.Long.TWO_PWR_63_DBL_) {
            return goog.math.Long.MAX_VALUE;
        } else if (value < 0) {
            return goog.math.Long.fromNumber(-value).negate();
        } else {
            return new goog.math.Long(
                (value % goog.math.Long.TWO_PWR_32_DBL_) | 0,
                (value / goog.math.Long.TWO_PWR_32_DBL_) | 0);
        }
    };


    /**
     * Returns a Long representing the 64-bit integer that comes by concatenating
     * the given high and low bits.  Each is assumed to use 32 bits.
     * @param {number} lowBits The low 32-bits.
     * @param {number} highBits The high 32-bits.
     * @return {!goog.math.Long} The corresponding Long value.
     */
    goog.math.Long.fromBits = function(lowBits, highBits) {
        return new goog.math.Long(lowBits, highBits);
    };


    /**
     * Returns a Long representation of the given string, written using the given
     * radix.
     * @param {string} str The textual representation of the Long.
     * @param {number=} opt_radix The radix in which the text is written.
     * @return {!goog.math.Long} The corresponding Long value.
     */
    goog.math.Long.fromString = function(str, opt_radix) {
        if (str.length == 0) {
            throw Error('number format error: empty string');
        }

        var radix = opt_radix || 10;
        if (radix < 2 || 36 < radix) {
            throw Error('radix out of range: ' + radix);
        }

        if (str.charAt(0) == '-') {
            return goog.math.Long.fromString(str.substring(1), radix).negate();
        } else if (str.indexOf('-') >= 0) {
            throw Error('number format error: interior "-" character: ' + str);
        }

        // Do several (8) digits each time through the loop, so as to
        // minimize the calls to the very expensive emulated div.
        var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 8));

        var result = goog.math.Long.ZERO;
        for (var i = 0; i < str.length; i += 8) {
            var size = Math.min(8, str.length - i);
            var value = parseInt(str.substring(i, i + size), radix);
            if (size < 8) {
                var power = goog.math.Long.fromNumber(Math.pow(radix, size));
                result = result.multiply(power).add(goog.math.Long.fromNumber(value));
            } else {
                result = result.multiply(radixToPower);
                result = result.add(goog.math.Long.fromNumber(value));
            }
        }
        return result;
    };


    // NOTE: the compiler should inline these constant values below and then remove
    // these variables, so there should be no runtime penalty for these.


    /**
     * Number used repeated below in calculations.  This must appear before the
     * first call to any from* function below.
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_16_DBL_ = 1 << 16;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_24_DBL_ = 1 << 24;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_32_DBL_ =
        goog.math.Long.TWO_PWR_16_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_31_DBL_ =
        goog.math.Long.TWO_PWR_32_DBL_ / 2;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_48_DBL_ =
        goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_16_DBL_;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_64_DBL_ =
        goog.math.Long.TWO_PWR_32_DBL_ * goog.math.Long.TWO_PWR_32_DBL_;


    /**
     * @type {number}
     * @private
     */
    goog.math.Long.TWO_PWR_63_DBL_ =
        goog.math.Long.TWO_PWR_64_DBL_ / 2;


    /** @type {!goog.math.Long} */
    goog.math.Long.ZERO = goog.math.Long.fromInt(0);


    /** @type {!goog.math.Long} */
    goog.math.Long.ONE = goog.math.Long.fromInt(1);


    /** @type {!goog.math.Long} */
    goog.math.Long.NEG_ONE = goog.math.Long.fromInt(-1);


    /** @type {!goog.math.Long} */
    goog.math.Long.MAX_VALUE =
        goog.math.Long.fromBits(0xFFFFFFFF | 0, 0x7FFFFFFF | 0);


    /** @type {!goog.math.Long} */
    goog.math.Long.MIN_VALUE = goog.math.Long.fromBits(0, 0x80000000 | 0);


    /**
     * @type {!goog.math.Long}
     * @private
     */
    goog.math.Long.TWO_PWR_24_ = goog.math.Long.fromInt(1 << 24);


    /** @return {number} The value, assuming it is a 32-bit integer. */
    goog.math.Long.prototype.toInt = function() {
        return this.low_;
    };


    /** @return {number} The closest floating-point representation to this value. */
    goog.math.Long.prototype.toNumber = function() {
        return this.high_ * goog.math.Long.TWO_PWR_32_DBL_ +
            this.getLowBitsUnsigned();
    };


    /**
     * @param {number=} opt_radix The radix in which the text should be written.
     * @return {string} The textual representation of this value.
     */
    goog.math.Long.prototype.toString = function(opt_radix) {
        var radix = opt_radix || 10;
        if (radix < 2 || 36 < radix) {
            throw Error('radix out of range: ' + radix);
        }

        if (this.isZero()) {
            return '0';
        }

        if (this.isNegative()) {
            if (this.equals(goog.math.Long.MIN_VALUE)) {
                // We need to change the Long value before it can be negated, so we remove
                // the bottom-most digit in this base and then recurse to do the rest.
                var radixLong = goog.math.Long.fromNumber(radix);
                var div = this.div(radixLong);
                var rem = div.multiply(radixLong).subtract(this);
                return div.toString(radix) + rem.toInt().toString(radix);
            } else {
                return '-' + this.negate().toString(radix);
            }
        }

        // Do several (6) digits each time through the loop, so as to
        // minimize the calls to the very expensive emulated div.
        var radixToPower = goog.math.Long.fromNumber(Math.pow(radix, 6));

        var rem = this;
        var result = '';
        while (true) {
            var remDiv = rem.div(radixToPower);
            var intval = rem.subtract(remDiv.multiply(radixToPower)).toInt();
            var digits = intval.toString(radix);

            rem = remDiv;
            if (rem.isZero()) {
                return digits + result;
            } else {
                while (digits.length < 6) {
                    digits = '0' + digits;
                }
                result = '' + digits + result;
            }
        }
    };


    /** @return {number} The high 32-bits as a signed value. */
    goog.math.Long.prototype.getHighBits = function() {
        return this.high_;
    };


    /** @return {number} The low 32-bits as a signed value. */
    goog.math.Long.prototype.getLowBits = function() {
        return this.low_;
    };


    /** @return {number} The low 32-bits as an unsigned value. */
    goog.math.Long.prototype.getLowBitsUnsigned = function() {
        return (this.low_ >= 0) ?
            this.low_ : goog.math.Long.TWO_PWR_32_DBL_ + this.low_;
    };


    /**
     * @return {number} Returns the number of bits needed to represent the absolute
     *     value of this Long.
     */
    goog.math.Long.prototype.getNumBitsAbs = function() {
        if (this.isNegative()) {
            if (this.equals(goog.math.Long.MIN_VALUE)) {
                return 64;
            } else {
                return this.negate().getNumBitsAbs();
            }
        } else {
            var val = this.high_ != 0 ? this.high_ : this.low_;
            for (var bit = 31; bit > 0; bit--) {
                if ((val & (1 << bit)) != 0) {
                    break;
                }
            }
            return this.high_ != 0 ? bit + 33 : bit + 1;
        }
    };


    /** @return {boolean} Whether this value is zero. */
    goog.math.Long.prototype.isZero = function() {
        return this.high_ == 0 && this.low_ == 0;
    };


    /** @return {boolean} Whether this value is negative. */
    goog.math.Long.prototype.isNegative = function() {
        return this.high_ < 0;
    };


    /** @return {boolean} Whether this value is odd. */
    goog.math.Long.prototype.isOdd = function() {
        return (this.low_ & 1) == 1;
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long equals the other.
     */
    goog.math.Long.prototype.equals = function(other) {
        return (this.high_ == other.high_) && (this.low_ == other.low_);
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long does not equal the other.
     */
    goog.math.Long.prototype.notEquals = function(other) {
        return (this.high_ != other.high_) || (this.low_ != other.low_);
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long is less than the other.
     */
    goog.math.Long.prototype.lessThan = function(other) {
        return this.compare(other) < 0;
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long is less than or equal to the other.
     */
    goog.math.Long.prototype.lessThanOrEqual = function(other) {
        return this.compare(other) <= 0;
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long is greater than the other.
     */
    goog.math.Long.prototype.greaterThan = function(other) {
        return this.compare(other) > 0;
    };


    /**
     * @param {goog.math.Long} other Long to compare against.
     * @return {boolean} Whether this Long is greater than or equal to the other.
     */
    goog.math.Long.prototype.greaterThanOrEqual = function(other) {
        return this.compare(other) >= 0;
    };


    /**
     * Compares this Long with the given one.
     * @param {goog.math.Long} other Long to compare against.
     * @return {number} 0 if they are the same, 1 if the this is greater, and -1
     *     if the given one is greater.
     */
    goog.math.Long.prototype.compare = function(other) {
        if (this.equals(other)) {
            return 0;
        }

        var thisNeg = this.isNegative();
        var otherNeg = other.isNegative();
        if (thisNeg && !otherNeg) {
            return -1;
        }
        if (!thisNeg && otherNeg) {
            return 1;
        }

        // at this point, the signs are the same, so subtraction will not overflow
        if (this.subtract(other).isNegative()) {
            return -1;
        } else {
            return 1;
        }
    };


    /** @return {!goog.math.Long} The negation of this value. */
    goog.math.Long.prototype.negate = function() {
        if (this.equals(goog.math.Long.MIN_VALUE)) {
            return goog.math.Long.MIN_VALUE;
        } else {
            return this.not().add(goog.math.Long.ONE);
        }
    };


    /**
     * Returns the sum of this and the given Long.
     * @param {goog.math.Long} other Long to add to this one.
     * @return {!goog.math.Long} The sum of this and the given Long.
     */
    goog.math.Long.prototype.add = function(other) {
        // Divide each number into 4 chunks of 16 bits, and then sum the chunks.

        var a48 = this.high_ >>> 16;
        var a32 = this.high_ & 0xFFFF;
        var a16 = this.low_ >>> 16;
        var a00 = this.low_ & 0xFFFF;

        var b48 = other.high_ >>> 16;
        var b32 = other.high_ & 0xFFFF;
        var b16 = other.low_ >>> 16;
        var b00 = other.low_ & 0xFFFF;

        var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
        c00 += a00 + b00;
        c16 += c00 >>> 16;
        c00 &= 0xFFFF;
        c16 += a16 + b16;
        c32 += c16 >>> 16;
        c16 &= 0xFFFF;
        c32 += a32 + b32;
        c48 += c32 >>> 16;
        c32 &= 0xFFFF;
        c48 += a48 + b48;
        c48 &= 0xFFFF;
        return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
    };


    /**
     * Returns the difference of this and the given Long.
     * @param {goog.math.Long} other Long to subtract from this.
     * @return {!goog.math.Long} The difference of this and the given Long.
     */
    goog.math.Long.prototype.subtract = function(other) {
        return this.add(other.negate());
    };


    /**
     * Returns the product of this and the given long.
     * @param {goog.math.Long} other Long to multiply with this.
     * @return {!goog.math.Long} The product of this and the other.
     */
    goog.math.Long.prototype.multiply = function(other) {
        if (this.isZero()) {
            return goog.math.Long.ZERO;
        } else if (other.isZero()) {
            return goog.math.Long.ZERO;
        }

        if (this.equals(goog.math.Long.MIN_VALUE)) {
            return other.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
        } else if (other.equals(goog.math.Long.MIN_VALUE)) {
            return this.isOdd() ? goog.math.Long.MIN_VALUE : goog.math.Long.ZERO;
        }

        if (this.isNegative()) {
            if (other.isNegative()) {
                return this.negate().multiply(other.negate());
            } else {
                return this.negate().multiply(other).negate();
            }
        } else if (other.isNegative()) {
            return this.multiply(other.negate()).negate();
        }

        // If both longs are small, use float multiplication
        if (this.lessThan(goog.math.Long.TWO_PWR_24_) &&
            other.lessThan(goog.math.Long.TWO_PWR_24_)) {
            return goog.math.Long.fromNumber(this.toNumber() * other.toNumber());
        }

        // Divide each long into 4 chunks of 16 bits, and then add up 4x4 products.
        // We can skip products that would overflow.

        var a48 = this.high_ >>> 16;
        var a32 = this.high_ & 0xFFFF;
        var a16 = this.low_ >>> 16;
        var a00 = this.low_ & 0xFFFF;

        var b48 = other.high_ >>> 16;
        var b32 = other.high_ & 0xFFFF;
        var b16 = other.low_ >>> 16;
        var b00 = other.low_ & 0xFFFF;

        var c48 = 0, c32 = 0, c16 = 0, c00 = 0;
        c00 += a00 * b00;
        c16 += c00 >>> 16;
        c00 &= 0xFFFF;
        c16 += a16 * b00;
        c32 += c16 >>> 16;
        c16 &= 0xFFFF;
        c16 += a00 * b16;
        c32 += c16 >>> 16;
        c16 &= 0xFFFF;
        c32 += a32 * b00;
        c48 += c32 >>> 16;
        c32 &= 0xFFFF;
        c32 += a16 * b16;
        c48 += c32 >>> 16;
        c32 &= 0xFFFF;
        c32 += a00 * b32;
        c48 += c32 >>> 16;
        c32 &= 0xFFFF;
        c48 += a48 * b00 + a32 * b16 + a16 * b32 + a00 * b48;
        c48 &= 0xFFFF;
        return goog.math.Long.fromBits((c16 << 16) | c00, (c48 << 16) | c32);
    };


    /**
     * Returns this Long divided by the given one.
     * @param {goog.math.Long} other Long by which to divide.
     * @return {!goog.math.Long} This Long divided by the given one.
     */
    goog.math.Long.prototype.div = function(other) {
        if (other.isZero()) {
            throw Error('division by zero');
        } else if (this.isZero()) {
            return goog.math.Long.ZERO;
        }

        if (this.equals(goog.math.Long.MIN_VALUE)) {
            if (other.equals(goog.math.Long.ONE) ||
                other.equals(goog.math.Long.NEG_ONE)) {
                return goog.math.Long.MIN_VALUE;  // recall that -MIN_VALUE == MIN_VALUE
            } else if (other.equals(goog.math.Long.MIN_VALUE)) {
                return goog.math.Long.ONE;
            } else {
                // At this point, we have |other| >= 2, so |this/other| < |MIN_VALUE|.
                var halfThis = this.shiftRight(1);
                var approx = halfThis.div(other).shiftLeft(1);
                if (approx.equals(goog.math.Long.ZERO)) {
                    return other.isNegative() ? goog.math.Long.ONE : goog.math.Long.NEG_ONE;
                } else {
                    var rem = this.subtract(other.multiply(approx));
                    var result = approx.add(rem.div(other));
                    return result;
                }
            }
        } else if (other.equals(goog.math.Long.MIN_VALUE)) {
            return goog.math.Long.ZERO;
        }

        if (this.isNegative()) {
            if (other.isNegative()) {
                return this.negate().div(other.negate());
            } else {
                return this.negate().div(other).negate();
            }
        } else if (other.isNegative()) {
            return this.div(other.negate()).negate();
        }

        // Repeat the following until the remainder is less than other:  find a
        // floating-point that approximates remainder / other *from below*, add this
        // into the result, and subtract it from the remainder.  It is critical that
        // the approximate value is less than or equal to the real value so that the
        // remainder never becomes negative.
        var res = goog.math.Long.ZERO;
        var rem = this;
        while (rem.greaterThanOrEqual(other)) {
            // Approximate the result of division. This may be a little greater or
            // smaller than the actual value.
            var approx = Math.max(1, Math.floor(rem.toNumber() / other.toNumber()));

            // We will tweak the approximate result by changing it in the 48-th digit or
            // the smallest non-fractional digit, whichever is larger.
            var log2 = Math.ceil(Math.log(approx) / Math.LN2);
            var delta = (log2 <= 48) ? 1 : Math.pow(2, log2 - 48);

            // Decrease the approximation until it is smaller than the remainder.  Note
            // that if it is too large, the product overflows and is negative.
            var approxRes = goog.math.Long.fromNumber(approx);
            var approxRem = approxRes.multiply(other);
            while (approxRem.isNegative() || approxRem.greaterThan(rem)) {
                approx -= delta;
                approxRes = goog.math.Long.fromNumber(approx);
                approxRem = approxRes.multiply(other);
            }

            // We know the answer can't be zero... and actually, zero would cause
            // infinite recursion since we would make no progress.
            if (approxRes.isZero()) {
                approxRes = goog.math.Long.ONE;
            }

            res = res.add(approxRes);
            rem = rem.subtract(approxRem);
        }
        return res;
    };


    /**
     * Returns this Long modulo the given one.
     * @param {goog.math.Long} other Long by which to mod.
     * @return {!goog.math.Long} This Long modulo the given one.
     */
    goog.math.Long.prototype.modulo = function(other) {
        return this.subtract(this.div(other).multiply(other));
    };


    /** @return {!goog.math.Long} The bitwise-NOT of this value. */
    goog.math.Long.prototype.not = function() {
        return goog.math.Long.fromBits(~this.low_, ~this.high_);
    };


    /**
     * Returns the bitwise-AND of this Long and the given one.
     * @param {goog.math.Long} other The Long with which to AND.
     * @return {!goog.math.Long} The bitwise-AND of this and the other.
     */
    goog.math.Long.prototype.and = function(other) {
        return goog.math.Long.fromBits(this.low_ & other.low_,
            this.high_ & other.high_);
    };


    /**
     * Returns the bitwise-OR of this Long and the given one.
     * @param {goog.math.Long} other The Long with which to OR.
     * @return {!goog.math.Long} The bitwise-OR of this and the other.
     */
    goog.math.Long.prototype.or = function(other) {
        return goog.math.Long.fromBits(this.low_ | other.low_,
            this.high_ | other.high_);
    };


    /**
     * Returns the bitwise-XOR of this Long and the given one.
     * @param {goog.math.Long} other The Long with which to XOR.
     * @return {!goog.math.Long} The bitwise-XOR of this and the other.
     */
    goog.math.Long.prototype.xor = function(other) {
        return goog.math.Long.fromBits(this.low_ ^ other.low_,
            this.high_ ^ other.high_);
    };


    /**
     * Returns this Long with bits shifted to the left by the given amount.
     * @param {number} numBits The number of bits by which to shift.
     * @return {!goog.math.Long} This shifted to the left by the given amount.
     */
    goog.math.Long.prototype.shiftLeft = function(numBits) {
        numBits &= 63;
        if (numBits == 0) {
            return this;
        } else {
            var low = this.low_;
            if (numBits < 32) {
                var high = this.high_;
                return goog.math.Long.fromBits(
                    low << numBits,
                    (high << numBits) | (low >>> (32 - numBits)));
            } else {
                return goog.math.Long.fromBits(0, low << (numBits - 32));
            }
        }
    };


    /**
     * Returns this Long with bits shifted to the right by the given amount.
     * @param {number} numBits The number of bits by which to shift.
     * @return {!goog.math.Long} This shifted to the right by the given amount.
     */
    goog.math.Long.prototype.shiftRight = function(numBits) {
        numBits &= 63;
        if (numBits == 0) {
            return this;
        } else {
            var high = this.high_;
            if (numBits < 32) {
                var low = this.low_;
                return goog.math.Long.fromBits(
                    (low >>> numBits) | (high << (32 - numBits)),
                    high >> numBits);
            } else {
                return goog.math.Long.fromBits(
                    high >> (numBits - 32),
                    high >= 0 ? 0 : -1);
            }
        }
    };


    /**
     * Returns this Long with bits shifted to the right by the given amount, with
     * the new top bits matching the current sign bit.
     * @param {number} numBits The number of bits by which to shift.
     * @return {!goog.math.Long} This shifted to the right by the given amount, with
     *     zeros placed into the new leading bits.
     */
    goog.math.Long.prototype.shiftRightUnsigned = function(numBits) {
        numBits &= 63;
        if (numBits == 0) {
            return this;
        } else {
            var high = this.high_;
            if (numBits < 32) {
                var low = this.low_;
                return goog.math.Long.fromBits(
                    (low >>> numBits) | (high << (32 - numBits)),
                    high >>> numBits);
            } else if (numBits == 32) {
                return goog.math.Long.fromBits(high, 0);
            } else {
                return goog.math.Long.fromBits(high >>> (numBits - 32), 0);
            }
        }
    };

    //======= begin jsbn =======

    var navigator = { appName: 'Modern Browser' }; // polyfill a little

    // Copyright (c) 2005  Tom Wu
    // All Rights Reserved.
    // http://www-cs-students.stanford.edu/~tjw/jsbn/

    /*
   * Copyright (c) 2003-2005  Tom Wu
   * All Rights Reserved.
   *
   * Permission is hereby granted, free of charge, to any person obtaining
   * a copy of this software and associated documentation files (the
   * "Software"), to deal in the Software without restriction, including
   * without limitation the rights to use, copy, modify, merge, publish,
   * distribute, sublicense, and/or sell copies of the Software, and to
   * permit persons to whom the Software is furnished to do so, subject to
   * the following conditions:
   *
   * The above copyright notice and this permission notice shall be
   * included in all copies or substantial portions of the Software.
   *
   * THE SOFTWARE IS PROVIDED "AS-IS" AND WITHOUT WARRANTY OF ANY KIND,
   * EXPRESS, IMPLIED OR OTHERWISE, INCLUDING WITHOUT LIMITATION, ANY
   * WARRANTY OF MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
   *
   * IN NO EVENT SHALL TOM WU BE LIABLE FOR ANY SPECIAL, INCIDENTAL,
   * INDIRECT OR CONSEQUENTIAL DAMAGES OF ANY KIND, OR ANY DAMAGES WHATSOEVER
   * RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER OR NOT ADVISED OF
   * THE POSSIBILITY OF DAMAGE, AND ON ANY THEORY OF LIABILITY, ARISING OUT
   * OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
   *
   * In addition, the following condition applies:
   *
   * All redistributions must retain an intact copy of this copyright notice
   * and disclaimer.
   */

    // Basic JavaScript BN library - subset useful for RSA encryption.

    // Bits per digit
    var dbits;

    // JavaScript engine analysis
    var canary = 0xdeadbeefcafe;
    var j_lm = ((canary&0xffffff)==0xefcafe);

    // (public) Constructor
    function BigInteger(a,b,c) {
        if(a != null)
            if("number" == typeof a) this.fromNumber(a,b,c);
            else if(b == null && "string" != typeof a) this.fromString(a,256);
            else this.fromString(a,b);
    }

    // return new, unset BigInteger
    function nbi() { return new BigInteger(null); }

    // am: Compute w_j += (x*this_i), propagate carries,
    // c is initial carry, returns final carry.
    // c < 3*dvalue, x < 2*dvalue, this_i < dvalue
    // We need to select the fastest one that works in this environment.

    // am1: use a single mult and divide to get the high bits,
    // max digit bits should be 26 because
    // max internal value = 2*dvalue^2-2*dvalue (< 2^53)
    function am1(i,x,w,j,c,n) {
        while(--n >= 0) {
            var v = x*this[i++]+w[j]+c;
            c = Math.floor(v/0x4000000);
            w[j++] = v&0x3ffffff;
        }
        return c;
    }
    // am2 avoids a big mult-and-extract completely.
    // Max digit bits should be <= 30 because we do bitwise ops
    // on values up to 2*hdvalue^2-hdvalue-1 (< 2^31)
    function am2(i,x,w,j,c,n) {
        var xl = x&0x7fff, xh = x>>15;
        while(--n >= 0) {
            var l = this[i]&0x7fff;
            var h = this[i++]>>15;
            var m = xh*l+h*xl;
            l = xl*l+((m&0x7fff)<<15)+w[j]+(c&0x3fffffff);
            c = (l>>>30)+(m>>>15)+xh*h+(c>>>30);
            w[j++] = l&0x3fffffff;
        }
        return c;
    }
    // Alternately, set max digit bits to 28 since some
    // browsers slow down when dealing with 32-bit numbers.
    function am3(i,x,w,j,c,n) {
        var xl = x&0x3fff, xh = x>>14;
        while(--n >= 0) {
            var l = this[i]&0x3fff;
            var h = this[i++]>>14;
            var m = xh*l+h*xl;
            l = xl*l+((m&0x3fff)<<14)+w[j]+c;
            c = (l>>28)+(m>>14)+xh*h;
            w[j++] = l&0xfffffff;
        }
        return c;
    }
    if(j_lm && (navigator.appName == "Microsoft Internet Explorer")) {
        BigInteger.prototype.am = am2;
        dbits = 30;
    }
    else if(j_lm && (navigator.appName != "Netscape")) {
        BigInteger.prototype.am = am1;
        dbits = 26;
    }
    else { // Mozilla/Netscape seems to prefer am3
        BigInteger.prototype.am = am3;
        dbits = 28;
    }

    BigInteger.prototype.DB = dbits;
    BigInteger.prototype.DM = ((1<<dbits)-1);
    BigInteger.prototype.DV = (1<<dbits);

    var BI_FP = 52;
    BigInteger.prototype.FV = Math.pow(2,BI_FP);
    BigInteger.prototype.F1 = BI_FP-dbits;
    BigInteger.prototype.F2 = 2*dbits-BI_FP;

    // Digit conversions
    var BI_RM = "0123456789abcdefghijklmnopqrstuvwxyz";
    var BI_RC = new Array();
    var rr,vv;
    rr = "0".charCodeAt(0);
    for(vv = 0; vv <= 9; ++vv) BI_RC[rr++] = vv;
    rr = "a".charCodeAt(0);
    for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;
    rr = "A".charCodeAt(0);
    for(vv = 10; vv < 36; ++vv) BI_RC[rr++] = vv;

    function int2char(n) { return BI_RM.charAt(n); }
    function intAt(s,i) {
        var c = BI_RC[s.charCodeAt(i)];
        return (c==null)?-1:c;
    }

    // (protected) copy this to r
    function bnpCopyTo(r) {
        for(var i = this.t-1; i >= 0; --i) r[i] = this[i];
        r.t = this.t;
        r.s = this.s;
    }

    // (protected) set from integer value x, -DV <= x < DV
    function bnpFromInt(x) {
        this.t = 1;
        this.s = (x<0)?-1:0;
        if(x > 0) this[0] = x;
        else if(x < -1) this[0] = x+DV;
        else this.t = 0;
    }

    // return bigint initialized to value
    function nbv(i) { var r = nbi(); r.fromInt(i); return r; }

    // (protected) set from string and radix
    function bnpFromString(s,b) {
        var k;
        if(b == 16) k = 4;
        else if(b == 8) k = 3;
        else if(b == 256) k = 8; // byte array
        else if(b == 2) k = 1;
        else if(b == 32) k = 5;
        else if(b == 4) k = 2;
        else { this.fromRadix(s,b); return; }
        this.t = 0;
        this.s = 0;
        var i = s.length, mi = false, sh = 0;
        while(--i >= 0) {
            var x = (k==8)?s[i]&0xff:intAt(s,i);
            if(x < 0) {
                if(s.charAt(i) == "-") mi = true;
                continue;
            }
            mi = false;
            if(sh == 0)
                this[this.t++] = x;
            else if(sh+k > this.DB) {
                this[this.t-1] |= (x&((1<<(this.DB-sh))-1))<<sh;
                this[this.t++] = (x>>(this.DB-sh));
            }
            else
                this[this.t-1] |= x<<sh;
            sh += k;
            if(sh >= this.DB) sh -= this.DB;
        }
        if(k == 8 && (s[0]&0x80) != 0) {
            this.s = -1;
            if(sh > 0) this[this.t-1] |= ((1<<(this.DB-sh))-1)<<sh;
        }
        this.clamp();
        if(mi) BigInteger.ZERO.subTo(this,this);
    }

    // (protected) clamp off excess high words
    function bnpClamp() {
        var c = this.s&this.DM;
        while(this.t > 0 && this[this.t-1] == c) --this.t;
    }

    // (public) return string representation in given radix
    function bnToString(b) {
        if(this.s < 0) return "-"+this.negate().toString(b);
        var k;
        if(b == 16) k = 4;
        else if(b == 8) k = 3;
        else if(b == 2) k = 1;
        else if(b == 32) k = 5;
        else if(b == 4) k = 2;
        else return this.toRadix(b);
        var km = (1<<k)-1, d, m = false, r = "", i = this.t;
        var p = this.DB-(i*this.DB)%k;
        if(i-- > 0) {
            if(p < this.DB && (d = this[i]>>p) > 0) { m = true; r = int2char(d); }
            while(i >= 0) {
                if(p < k) {
                    d = (this[i]&((1<<p)-1))<<(k-p);
                    d |= this[--i]>>(p+=this.DB-k);
                }
                else {
                    d = (this[i]>>(p-=k))&km;
                    if(p <= 0) { p += this.DB; --i; }
                }
                if(d > 0) m = true;
                if(m) r += int2char(d);
            }
        }
        return m?r:"0";
    }

    // (public) -this
    function bnNegate() { var r = nbi(); BigInteger.ZERO.subTo(this,r); return r; }

    // (public) |this|
    function bnAbs() { return (this.s<0)?this.negate():this; }

    // (public) return + if this > a, - if this < a, 0 if equal
    function bnCompareTo(a) {
        var r = this.s-a.s;
        if(r != 0) return r;
        var i = this.t;
        r = i-a.t;
        if(r != 0) return (this.s<0)?-r:r;
        while(--i >= 0) if((r=this[i]-a[i]) != 0) return r;
        return 0;
    }

    // returns bit length of the integer x
    function nbits(x) {
        var r = 1, t;
        if((t=x>>>16) != 0) { x = t; r += 16; }
        if((t=x>>8) != 0) { x = t; r += 8; }
        if((t=x>>4) != 0) { x = t; r += 4; }
        if((t=x>>2) != 0) { x = t; r += 2; }
        if((t=x>>1) != 0) { x = t; r += 1; }
        return r;
    }

    // (public) return the number of bits in "this"
    function bnBitLength() {
        if(this.t <= 0) return 0;
        return this.DB*(this.t-1)+nbits(this[this.t-1]^(this.s&this.DM));
    }

    // (protected) r = this << n*DB
    function bnpDLShiftTo(n,r) {
        var i;
        for(i = this.t-1; i >= 0; --i) r[i+n] = this[i];
        for(i = n-1; i >= 0; --i) r[i] = 0;
        r.t = this.t+n;
        r.s = this.s;
    }

    // (protected) r = this >> n*DB
    function bnpDRShiftTo(n,r) {
        for(var i = n; i < this.t; ++i) r[i-n] = this[i];
        r.t = Math.max(this.t-n,0);
        r.s = this.s;
    }

    // (protected) r = this << n
    function bnpLShiftTo(n,r) {
        var bs = n%this.DB;
        var cbs = this.DB-bs;
        var bm = (1<<cbs)-1;
        var ds = Math.floor(n/this.DB), c = (this.s<<bs)&this.DM, i;
        for(i = this.t-1; i >= 0; --i) {
            r[i+ds+1] = (this[i]>>cbs)|c;
            c = (this[i]&bm)<<bs;
        }
        for(i = ds-1; i >= 0; --i) r[i] = 0;
        r[ds] = c;
        r.t = this.t+ds+1;
        r.s = this.s;
        r.clamp();
    }

    // (protected) r = this >> n
    function bnpRShiftTo(n,r) {
        r.s = this.s;
        var ds = Math.floor(n/this.DB);
        if(ds >= this.t) { r.t = 0; return; }
        var bs = n%this.DB;
        var cbs = this.DB-bs;
        var bm = (1<<bs)-1;
        r[0] = this[ds]>>bs;
        for(var i = ds+1; i < this.t; ++i) {
            r[i-ds-1] |= (this[i]&bm)<<cbs;
            r[i-ds] = this[i]>>bs;
        }
        if(bs > 0) r[this.t-ds-1] |= (this.s&bm)<<cbs;
        r.t = this.t-ds;
        r.clamp();
    }

    // (protected) r = this - a
    function bnpSubTo(a,r) {
        var i = 0, c = 0, m = Math.min(a.t,this.t);
        while(i < m) {
            c += this[i]-a[i];
            r[i++] = c&this.DM;
            c >>= this.DB;
        }
        if(a.t < this.t) {
            c -= a.s;
            while(i < this.t) {
                c += this[i];
                r[i++] = c&this.DM;
                c >>= this.DB;
            }
            c += this.s;
        }
        else {
            c += this.s;
            while(i < a.t) {
                c -= a[i];
                r[i++] = c&this.DM;
                c >>= this.DB;
            }
            c -= a.s;
        }
        r.s = (c<0)?-1:0;
        if(c < -1) r[i++] = this.DV+c;
        else if(c > 0) r[i++] = c;
        r.t = i;
        r.clamp();
    }

    // (protected) r = this * a, r != this,a (HAC 14.12)
    // "this" should be the larger one if appropriate.
    function bnpMultiplyTo(a,r) {
        var x = this.abs(), y = a.abs();
        var i = x.t;
        r.t = i+y.t;
        while(--i >= 0) r[i] = 0;
        for(i = 0; i < y.t; ++i) r[i+x.t] = x.am(0,y[i],r,i,0,x.t);
        r.s = 0;
        r.clamp();
        if(this.s != a.s) BigInteger.ZERO.subTo(r,r);
    }

    // (protected) r = this^2, r != this (HAC 14.16)
    function bnpSquareTo(r) {
        var x = this.abs();
        var i = r.t = 2*x.t;
        while(--i >= 0) r[i] = 0;
        for(i = 0; i < x.t-1; ++i) {
            var c = x.am(i,x[i],r,2*i,0,1);
            if((r[i+x.t]+=x.am(i+1,2*x[i],r,2*i+1,c,x.t-i-1)) >= x.DV) {
                r[i+x.t] -= x.DV;
                r[i+x.t+1] = 1;
            }
        }
        if(r.t > 0) r[r.t-1] += x.am(i,x[i],r,2*i,0,1);
        r.s = 0;
        r.clamp();
    }

    // (protected) divide this by m, quotient and remainder to q, r (HAC 14.20)
    // r != q, this != m.  q or r may be null.
    function bnpDivRemTo(m,q,r) {
        var pm = m.abs();
        if(pm.t <= 0) return;
        var pt = this.abs();
        if(pt.t < pm.t) {
            if(q != null) q.fromInt(0);
            if(r != null) this.copyTo(r);
            return;
        }
        if(r == null) r = nbi();
        var y = nbi(), ts = this.s, ms = m.s;
        var nsh = this.DB-nbits(pm[pm.t-1]);	// normalize modulus
        if(nsh > 0) { pm.lShiftTo(nsh,y); pt.lShiftTo(nsh,r); }
        else { pm.copyTo(y); pt.copyTo(r); }
        var ys = y.t;
        var y0 = y[ys-1];
        if(y0 == 0) return;
        var yt = y0*(1<<this.F1)+((ys>1)?y[ys-2]>>this.F2:0);
        var d1 = this.FV/yt, d2 = (1<<this.F1)/yt, e = 1<<this.F2;
        var i = r.t, j = i-ys, t = (q==null)?nbi():q;
        y.dlShiftTo(j,t);
        if(r.compareTo(t) >= 0) {
            r[r.t++] = 1;
            r.subTo(t,r);
        }
        BigInteger.ONE.dlShiftTo(ys,t);
        t.subTo(y,y);	// "negative" y so we can replace sub with am later
        while(y.t < ys) y[y.t++] = 0;
        while(--j >= 0) {
            // Estimate quotient digit
            var qd = (r[--i]==y0)?this.DM:Math.floor(r[i]*d1+(r[i-1]+e)*d2);
            if((r[i]+=y.am(0,qd,r,j,0,ys)) < qd) {	// Try it out
                y.dlShiftTo(j,t);
                r.subTo(t,r);
                while(r[i] < --qd) r.subTo(t,r);
            }
        }
        if(q != null) {
            r.drShiftTo(ys,q);
            if(ts != ms) BigInteger.ZERO.subTo(q,q);
        }
        r.t = ys;
        r.clamp();
        if(nsh > 0) r.rShiftTo(nsh,r);	// Denormalize remainder
        if(ts < 0) BigInteger.ZERO.subTo(r,r);
    }

    // (public) this mod a
    function bnMod(a) {
        var r = nbi();
        this.abs().divRemTo(a,null,r);
        if(this.s < 0 && r.compareTo(BigInteger.ZERO) > 0) a.subTo(r,r);
        return r;
    }

    // Modular reduction using "classic" algorithm
    function Classic(m) { this.m = m; }
    function cConvert(x) {
        if(x.s < 0 || x.compareTo(this.m) >= 0) return x.mod(this.m);
        else return x;
    }
    function cRevert(x) { return x; }
    function cReduce(x) { x.divRemTo(this.m,null,x); }
    function cMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }
    function cSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

    Classic.prototype.convert = cConvert;
    Classic.prototype.revert = cRevert;
    Classic.prototype.reduce = cReduce;
    Classic.prototype.mulTo = cMulTo;
    Classic.prototype.sqrTo = cSqrTo;

    // (protected) return "-1/this % 2^DB"; useful for Mont. reduction
    // justification:
    //         xy == 1 (mod m)
    //         xy =  1+km
    //   xy(2-xy) = (1+km)(1-km)
    // x[y(2-xy)] = 1-k^2m^2
    // x[y(2-xy)] == 1 (mod m^2)
    // if y is 1/x mod m, then y(2-xy) is 1/x mod m^2
    // should reduce x and y(2-xy) by m^2 at each step to keep size bounded.
    // JS multiply "overflows" differently from C/C++, so care is needed here.
    function bnpInvDigit() {
        if(this.t < 1) return 0;
        var x = this[0];
        if((x&1) == 0) return 0;
        var y = x&3;		// y == 1/x mod 2^2
        y = (y*(2-(x&0xf)*y))&0xf;	// y == 1/x mod 2^4
        y = (y*(2-(x&0xff)*y))&0xff;	// y == 1/x mod 2^8
        y = (y*(2-(((x&0xffff)*y)&0xffff)))&0xffff;	// y == 1/x mod 2^16
        // last step - calculate inverse mod DV directly;
        // assumes 16 < DB <= 32 and assumes ability to handle 48-bit ints
        y = (y*(2-x*y%this.DV))%this.DV;		// y == 1/x mod 2^dbits
        // we really want the negative inverse, and -DV < y < DV
        return (y>0)?this.DV-y:-y;
    }

    // Montgomery reduction
    function Montgomery(m) {
        this.m = m;
        this.mp = m.invDigit();
        this.mpl = this.mp&0x7fff;
        this.mph = this.mp>>15;
        this.um = (1<<(m.DB-15))-1;
        this.mt2 = 2*m.t;
    }

    // xR mod m
    function montConvert(x) {
        var r = nbi();
        x.abs().dlShiftTo(this.m.t,r);
        r.divRemTo(this.m,null,r);
        if(x.s < 0 && r.compareTo(BigInteger.ZERO) > 0) this.m.subTo(r,r);
        return r;
    }

    // x/R mod m
    function montRevert(x) {
        var r = nbi();
        x.copyTo(r);
        this.reduce(r);
        return r;
    }

    // x = x/R mod m (HAC 14.32)
    function montReduce(x) {
        while(x.t <= this.mt2)	// pad x so am has enough room later
            x[x.t++] = 0;
        for(var i = 0; i < this.m.t; ++i) {
            // faster way of calculating u0 = x[i]*mp mod DV
            var j = x[i]&0x7fff;
            var u0 = (j*this.mpl+(((j*this.mph+(x[i]>>15)*this.mpl)&this.um)<<15))&x.DM;
            // use am to combine the multiply-shift-add into one call
            j = i+this.m.t;
            x[j] += this.m.am(0,u0,x,i,0,this.m.t);
            // propagate carry
            while(x[j] >= x.DV) { x[j] -= x.DV; x[++j]++; }
        }
        x.clamp();
        x.drShiftTo(this.m.t,x);
        if(x.compareTo(this.m) >= 0) x.subTo(this.m,x);
    }

    // r = "x^2/R mod m"; x != r
    function montSqrTo(x,r) { x.squareTo(r); this.reduce(r); }

    // r = "xy/R mod m"; x,y != r
    function montMulTo(x,y,r) { x.multiplyTo(y,r); this.reduce(r); }

    Montgomery.prototype.convert = montConvert;
    Montgomery.prototype.revert = montRevert;
    Montgomery.prototype.reduce = montReduce;
    Montgomery.prototype.mulTo = montMulTo;
    Montgomery.prototype.sqrTo = montSqrTo;

    // (protected) true iff this is even
    function bnpIsEven() { return ((this.t>0)?(this[0]&1):this.s) == 0; }

    // (protected) this^e, e < 2^32, doing sqr and mul with "r" (HAC 14.79)
    function bnpExp(e,z) {
        if(e > 0xffffffff || e < 1) return BigInteger.ONE;
        var r = nbi(), r2 = nbi(), g = z.convert(this), i = nbits(e)-1;
        g.copyTo(r);
        while(--i >= 0) {
            z.sqrTo(r,r2);
            if((e&(1<<i)) > 0) z.mulTo(r2,g,r);
            else { var t = r; r = r2; r2 = t; }
        }
        return z.revert(r);
    }

    // (public) this^e % m, 0 <= e < 2^32
    function bnModPowInt(e,m) {
        var z;
        if(e < 256 || m.isEven()) z = new Classic(m); else z = new Montgomery(m);
        return this.exp(e,z);
    }

    // protected
    BigInteger.prototype.copyTo = bnpCopyTo;
    BigInteger.prototype.fromInt = bnpFromInt;
    BigInteger.prototype.fromString = bnpFromString;
    BigInteger.prototype.clamp = bnpClamp;
    BigInteger.prototype.dlShiftTo = bnpDLShiftTo;
    BigInteger.prototype.drShiftTo = bnpDRShiftTo;
    BigInteger.prototype.lShiftTo = bnpLShiftTo;
    BigInteger.prototype.rShiftTo = bnpRShiftTo;
    BigInteger.prototype.subTo = bnpSubTo;
    BigInteger.prototype.multiplyTo = bnpMultiplyTo;
    BigInteger.prototype.squareTo = bnpSquareTo;
    BigInteger.prototype.divRemTo = bnpDivRemTo;
    BigInteger.prototype.invDigit = bnpInvDigit;
    BigInteger.prototype.isEven = bnpIsEven;
    BigInteger.prototype.exp = bnpExp;

    // public
    BigInteger.prototype.toString = bnToString;
    BigInteger.prototype.negate = bnNegate;
    BigInteger.prototype.abs = bnAbs;
    BigInteger.prototype.compareTo = bnCompareTo;
    BigInteger.prototype.bitLength = bnBitLength;
    BigInteger.prototype.mod = bnMod;
    BigInteger.prototype.modPowInt = bnModPowInt;

    // "constants"
    BigInteger.ZERO = nbv(0);
    BigInteger.ONE = nbv(1);

    // jsbn2 stuff

    // (protected) convert from radix string
    function bnpFromRadix(s,b) {
        this.fromInt(0);
        if(b == null) b = 10;
        var cs = this.chunkSize(b);
        var d = Math.pow(b,cs), mi = false, j = 0, w = 0;
        for(var i = 0; i < s.length; ++i) {
            var x = intAt(s,i);
            if(x < 0) {
                if(s.charAt(i) == "-" && this.signum() == 0) mi = true;
                continue;
            }
            w = b*w+x;
            if(++j >= cs) {
                this.dMultiply(d);
                this.dAddOffset(w,0);
                j = 0;
                w = 0;
            }
        }
        if(j > 0) {
            this.dMultiply(Math.pow(b,j));
            this.dAddOffset(w,0);
        }
        if(mi) BigInteger.ZERO.subTo(this,this);
    }

    // (protected) return x s.t. r^x < DV
    function bnpChunkSize(r) { return Math.floor(Math.LN2*this.DB/Math.log(r)); }

    // (public) 0 if this == 0, 1 if this > 0
    function bnSigNum() {
        if(this.s < 0) return -1;
        else if(this.t <= 0 || (this.t == 1 && this[0] <= 0)) return 0;
        else return 1;
    }

    // (protected) this *= n, this >= 0, 1 < n < DV
    function bnpDMultiply(n) {
        this[this.t] = this.am(0,n-1,this,0,0,this.t);
        ++this.t;
        this.clamp();
    }

    // (protected) this += n << w words, this >= 0
    function bnpDAddOffset(n,w) {
        if(n == 0) return;
        while(this.t <= w) this[this.t++] = 0;
        this[w] += n;
        while(this[w] >= this.DV) {
            this[w] -= this.DV;
            if(++w >= this.t) this[this.t++] = 0;
            ++this[w];
        }
    }

    // (protected) convert to radix string
    function bnpToRadix(b) {
        if(b == null) b = 10;
        if(this.signum() == 0 || b < 2 || b > 36) return "0";
        var cs = this.chunkSize(b);
        var a = Math.pow(b,cs);
        var d = nbv(a), y = nbi(), z = nbi(), r = "";
        this.divRemTo(d,y,z);
        while(y.signum() > 0) {
            r = (a+z.intValue()).toString(b).substr(1) + r;
            y.divRemTo(d,y,z);
        }
        return z.intValue().toString(b) + r;
    }

    // (public) return value as integer
    function bnIntValue() {
        if(this.s < 0) {
            if(this.t == 1) return this[0]-this.DV;
            else if(this.t == 0) return -1;
        }
        else if(this.t == 1) return this[0];
        else if(this.t == 0) return 0;
        // assumes 16 < DB < 32
        return ((this[1]&((1<<(32-this.DB))-1))<<this.DB)|this[0];
    }

    // (protected) r = this + a
    function bnpAddTo(a,r) {
        var i = 0, c = 0, m = Math.min(a.t,this.t);
        while(i < m) {
            c += this[i]+a[i];
            r[i++] = c&this.DM;
            c >>= this.DB;
        }
        if(a.t < this.t) {
            c += a.s;
            while(i < this.t) {
                c += this[i];
                r[i++] = c&this.DM;
                c >>= this.DB;
            }
            c += this.s;
        }
        else {
            c += this.s;
            while(i < a.t) {
                c += a[i];
                r[i++] = c&this.DM;
                c >>= this.DB;
            }
            c += a.s;
        }
        r.s = (c<0)?-1:0;
        if(c > 0) r[i++] = c;
        else if(c < -1) r[i++] = this.DV+c;
        r.t = i;
        r.clamp();
    }

    BigInteger.prototype.fromRadix = bnpFromRadix;
    BigInteger.prototype.chunkSize = bnpChunkSize;
    BigInteger.prototype.signum = bnSigNum;
    BigInteger.prototype.dMultiply = bnpDMultiply;
    BigInteger.prototype.dAddOffset = bnpDAddOffset;
    BigInteger.prototype.toRadix = bnpToRadix;
    BigInteger.prototype.intValue = bnIntValue;
    BigInteger.prototype.addTo = bnpAddTo;

    //======= end jsbn =======

    // Emscripten wrapper
    var Wrapper = {
        abs: function(l, h) {
            var x = new goog.math.Long(l, h);
            var ret;
            if (x.isNegative()) {
                ret = x.negate();
            } else {
                ret = x;
            }
            HEAP32[tempDoublePtr>>2] = ret.low_;
            HEAP32[tempDoublePtr+4>>2] = ret.high_;
        },
        ensureTemps: function() {
            if (Wrapper.ensuredTemps) return;
            Wrapper.ensuredTemps = true;
            Wrapper.two32 = new BigInteger();
            Wrapper.two32.fromString('4294967296', 10);
            Wrapper.two64 = new BigInteger();
            Wrapper.two64.fromString('18446744073709551616', 10);
            Wrapper.temp1 = new BigInteger();
            Wrapper.temp2 = new BigInteger();
        },
        lh2bignum: function(l, h) {
            var a = new BigInteger();
            a.fromString(h.toString(), 10);
            var b = new BigInteger();
            a.multiplyTo(Wrapper.two32, b);
            var c = new BigInteger();
            c.fromString(l.toString(), 10);
            var d = new BigInteger();
            c.addTo(b, d);
            return d;
        },
        stringify: function(l, h, unsigned) {
            var ret = new goog.math.Long(l, h).toString();
            if (unsigned && ret[0] == '-') {
                // unsign slowly using jsbn bignums
                Wrapper.ensureTemps();
                var bignum = new BigInteger();
                bignum.fromString(ret, 10);
                ret = new BigInteger();
                Wrapper.two64.addTo(bignum, ret);
                ret = ret.toString(10);
            }
            return ret;
        },
        fromString: function(str, base, min, max, unsigned) {
            Wrapper.ensureTemps();
            var bignum = new BigInteger();
            bignum.fromString(str, base);
            var bigmin = new BigInteger();
            bigmin.fromString(min, 10);
            var bigmax = new BigInteger();
            bigmax.fromString(max, 10);
            if (unsigned && bignum.compareTo(BigInteger.ZERO) < 0) {
                var temp = new BigInteger();
                bignum.addTo(Wrapper.two64, temp);
                bignum = temp;
            }
            var error = false;
            if (bignum.compareTo(bigmin) < 0) {
                bignum = bigmin;
                error = true;
            } else if (bignum.compareTo(bigmax) > 0) {
                bignum = bigmax;
                error = true;
            }
            var ret = goog.math.Long.fromString(bignum.toString()); // min-max checks should have clamped this to a range goog.math.Long can handle well
            HEAP32[tempDoublePtr>>2] = ret.low_;
            HEAP32[tempDoublePtr+4>>2] = ret.high_;
            if (error) throw 'range error';
        }
    };
    return Wrapper;
})();

//======= end closure i64 code =======



// === Auto-generated postamble setup entry stuff ===

if (memoryInitializer) {
    if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
        var data = Module['readBinary'](memoryInitializer);
        HEAPU8.set(data, STATIC_BASE);
    } else {
        addRunDependency('memory initializer');
        Browser.asyncLoad(memoryInitializer, function(data) {
            HEAPU8.set(data, STATIC_BASE);
            removeRunDependency('memory initializer');
        }, function(data) {
            throw 'could not load memory initializer ' + memoryInitializer;
        });
    }
}

function ExitStatus(status) {
    this.name = "ExitStatus";
    this.message = "Program terminated with exit(" + status + ")";
    this.status = status;
};
ExitStatus.prototype = new Error();
ExitStatus.prototype.constructor = ExitStatus;

var initialStackTop;
var preloadStartTime = null;
var calledMain = false;

dependenciesFulfilled = function runCaller() {
    // If run has never been called, and we should call run (INVOKE_RUN is true, and Module.noInitialRun is not false)
    if (!Module['calledRun'] && shouldRunNow) run();
    if (!Module['calledRun']) dependenciesFulfilled = runCaller; // try this again later, after new deps are fulfilled
}

Module['callMain'] = Module.callMain = function callMain(args) {
    assert(runDependencies == 0, 'cannot call main when async dependencies remain! (listen on __ATMAIN__)');
    assert(__ATPRERUN__.length == 0, 'cannot call main when preRun functions remain to be called');

    args = args || [];

    ensureInitRuntime();

    var argc = args.length+1;
    function pad() {
        for (var i = 0; i < 4-1; i++) {
            argv.push(0);
        }
    }
    var argv = [allocate(intArrayFromString("/bin/this.program"), 'i8', ALLOC_NORMAL) ];
    pad();
    for (var i = 0; i < argc-1; i = i + 1) {
        argv.push(allocate(intArrayFromString(args[i]), 'i8', ALLOC_NORMAL));
        pad();
    }
    argv.push(0);
    argv = allocate(argv, 'i32', ALLOC_NORMAL);

    initialStackTop = STACKTOP;

    try {

        var ret = Module['_main'](argc, argv, 0);


        // if we're not running an evented main loop, it's time to exit
        if (!Module['noExitRuntime']) {
            exit(ret);
        }
    }
    catch(e) {
        if (e instanceof ExitStatus) {
            // exit() throws this once it's done to make sure execution
            // has been stopped completely
            return;
        } else if (e == 'SimulateInfiniteLoop') {
            // running an evented main loop, don't immediately exit
            Module['noExitRuntime'] = true;
            return;
        } else {
            if (e && typeof e === 'object' && e.stack) Module.printErr('exception thrown: ' + [e, e.stack]);
            throw e;
        }
    } finally {
        calledMain = true;
    }
}




function run(args) {
    args = args || Module['arguments'];

    if (preloadStartTime === null) preloadStartTime = Date.now();

    if (runDependencies > 0) {
        Module.printErr('run() called, but dependencies remain, so not running');
        return;
    }

    preRun();

    if (runDependencies > 0) return; // a preRun added a dependency, run will be called later
    if (Module['calledRun']) return; // run may have just been called through dependencies being fulfilled just in this very frame

    function doRun() {
        if (Module['calledRun']) return; // run may have just been called while the async setStatus time below was happening
        Module['calledRun'] = true;

        ensureInitRuntime();

        preMain();

        if (ENVIRONMENT_IS_WEB && preloadStartTime !== null) {
            Module.printErr('pre-main prep time: ' + (Date.now() - preloadStartTime) + ' ms');
        }

        if (Module['_main'] && shouldRunNow) {
            Module['callMain'](args);
        }

        postRun();
    }

    if (Module['setStatus']) {
        Module['setStatus']('Running...');
        setTimeout(function() {
            setTimeout(function() {
                Module['setStatus']('');
            }, 1);
            if (!ABORT) doRun();
        }, 1);
    } else {
        doRun();
    }
}
Module['run'] = Module.run = run;

function exit(status) {
    ABORT = true;
    EXITSTATUS = status;
    STACKTOP = initialStackTop;

    // exit the runtime
    exitRuntime();

    // TODO We should handle this differently based on environment.
    // In the browser, the best we can do is throw an exception
    // to halt execution, but in node we could process.exit and
    // I'd imagine SM shell would have something equivalent.
    // This would let us set a proper exit status (which
    // would be great for checking test exit statuses).
    // https://github.com/kripken/emscripten/issues/1371

    // throw an exception to halt the current execution
    throw new ExitStatus(status);
}
Module['exit'] = Module.exit = exit;

function abort(text) {
    if (text) {
        Module.print(text);
        Module.printErr(text);
    }

    ABORT = true;
    EXITSTATUS = 1;

    var extra = '\nIf this abort() is unexpected, build with -s ASSERTIONS=1 which can give more information.';

    throw 'abort() at ' + stackTrace() + extra;
}
Module['abort'] = Module.abort = abort;

// {{PRE_RUN_ADDITIONS}}

if (Module['preInit']) {
    if (typeof Module['preInit'] == 'function') Module['preInit'] = [Module['preInit']];
    while (Module['preInit'].length > 0) {
        Module['preInit'].pop()();
    }
}

// shouldRunNow refers to calling main(), not run().
var shouldRunNow = true;
if (Module['noInitialRun']) {
    shouldRunNow = false;
}


run();

// {{POST_RUN_ADDITIONS}}






// {{MODULE_ADDITIONS}}




