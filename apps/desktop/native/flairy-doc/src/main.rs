use std::{
    env, fs,
    io::{self, Write},
    path::PathBuf,
    process,
};

const HELP: &str = "flairy-doc: convert a document to GitHub-Flavored Markdown

Usage:
  flairy-doc <file> [-o <markdown-file>]

Options:
  -o, --output <path>  Write Markdown to a file instead of stdout
  -h, --help           Print this help
  -V, --version        Print the version

Supported files: doc, docx, docm, ppt, pps, pot, pptx, pptm, ppsx, ppsm,
xls, xlsx, xlsm, xlsb, odt, ods, odp, rtf, epub, csv, and text-based pdf.
";

fn main() {
    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut args = env::args_os().skip(1);
    let mut positional_only = false;

    while let Some(arg) = args.next() {
        if positional_only || !arg.to_string_lossy().starts_with('-') {
            if input.replace(PathBuf::from(&arg)).is_some() {
                fail(format!(
                    "expected one input file, found an extra argument: {}",
                    arg.to_string_lossy()
                ));
            }
            continue;
        }

        match arg.to_string_lossy().as_ref() {
            "--" => positional_only = true,
            "-h" | "--help" => {
                print!("{HELP}");
                return;
            }
            "-V" | "--version" => {
                println!("{}", env!("CARGO_PKG_VERSION"));
                return;
            }
            "-o" | "--output" => {
                let Some(path) = args.next() else {
                    fail("--output requires a path");
                };
                output = Some(PathBuf::from(path));
            }
            option => fail(format!(
                "unknown option: {option}\nRun flairy-doc --help for usage."
            )),
        }
    }

    let Some(input) = input else {
        fail("missing input file\nRun flairy-doc --help for usage.");
    };
    let markdown = anydoc::to_markdown(&input)
        .unwrap_or_else(|error| fail(format!("{}: {error}", input.display())));

    if let Some(output) = output {
        let same_file = output == input
            || (output.exists() && fs::canonicalize(&output).ok() == fs::canonicalize(&input).ok());
        if same_file {
            fail("output path must not overwrite the input document");
        }
        fs::write(&output, markdown)
            .unwrap_or_else(|error| fail(format!("{}: {error}", output.display())));
    } else if let Err(error) = io::stdout().lock().write_all(markdown.as_bytes())
        && error.kind() != io::ErrorKind::BrokenPipe
    {
        fail(error);
    }
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("flairy-doc: {message}");
    process::exit(1);
}
