use std::{fs, path::PathBuf, process::Command};

#[test]
fn converts_csv_to_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_flairy-doc"))
        .arg(fixture())
        .output()
        .expect("run flairy-doc");

    assert!(output.status.success());
    let markdown = String::from_utf8(output.stdout).expect("utf-8 output");
    assert!(markdown.contains("| name | revenue |"));
    assert!(markdown.contains("| Flairy | 42 |"));
}

#[test]
fn writes_markdown_to_output_file() {
    let output_path = std::env::temp_dir().join(format!(
        "flairy-doc-test-{}-{}.md",
        std::process::id(),
        std::thread::current().name().unwrap_or("output")
    ));
    let output = Command::new(env!("CARGO_BIN_EXE_flairy-doc"))
        .arg(fixture())
        .args(["-o", output_path.to_str().expect("utf-8 temp path")])
        .output()
        .expect("run flairy-doc");

    assert!(output.status.success());
    assert!(output.stdout.is_empty());
    let markdown = fs::read_to_string(&output_path).expect("read output file");
    fs::remove_file(output_path).expect("remove output file");
    assert!(markdown.contains("| Anydoc | 17 |"));
}

#[test]
fn refuses_to_overwrite_input_document() {
    let input_path =
        std::env::temp_dir().join(format!("flairy-doc-test-{}-input.csv", std::process::id()));
    fs::copy(fixture(), &input_path).expect("copy input fixture");
    let before = fs::read(&input_path).expect("read input before conversion");
    let output = Command::new(env!("CARGO_BIN_EXE_flairy-doc"))
        .arg(&input_path)
        .args(["-o", input_path.to_str().expect("utf-8 temp path")])
        .output()
        .expect("run flairy-doc");
    let after = fs::read(&input_path).expect("read input after conversion");
    fs::remove_file(input_path).expect("remove input copy");

    assert!(!output.status.success());
    assert_eq!(after, before);
    assert!(String::from_utf8_lossy(&output.stderr).contains("must not overwrite"));
}

fn fixture() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sample.csv")
}
