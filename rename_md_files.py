#!/usr/bin/env python3
import os
import argparse
import sys

def add_one_to_md(folder_path):
    """Add '1' before .md extension in all .md files in the folder."""
    for filename in os.listdir(folder_path):
        if filename.endswith('.md'):
            old_path = os.path.join(folder_path, filename)
            new_filename = filename[:-3] + '1.md'  # Remove .md, add 1.md
            new_path = os.path.join(folder_path, new_filename)
            try:
                os.rename(old_path, new_path)
                print(f"Renamed: {filename} -> {new_filename}")
            except Exception as e:
                print(f"Error renaming {filename}: {e}")

def remove_one_from_md(folder_path):
    """Remove '1' before .md extension in all .md files in the folder."""
    for filename in os.listdir(folder_path):
        if filename.endswith('1.md'):
            old_path = os.path.join(folder_path, filename)
            new_filename = filename[:-5] + '.md'  # Remove 1.md, add .md
            new_path = os.path.join(folder_path, new_filename)
            try:
                os.rename(old_path, new_path)
                print(f"Renamed: {filename} -> {new_filename}")
            except Exception as e:
                print(f"Error renaming {filename}: {e}")

def main():
    parser = argparse.ArgumentParser(description='Rename .md files by adding or removing "1" before the extension')
    parser.add_argument('folder', help='Path to the folder containing .md files')
    parser.add_argument('--mode', choices=['add', 'remove'], required=True,
                      help='Mode: "add" to add "1" before .md, "remove" to remove it')
    
    args = parser.parse_args()
    
    if not os.path.isdir(args.folder):
        print(f"Error: {args.folder} is not a valid directory")
        sys.exit(1)
    
    if args.mode == 'add':
        add_one_to_md(args.folder)
    else:
        remove_one_from_md(args.folder)

if __name__ == '__main__':
    main() 