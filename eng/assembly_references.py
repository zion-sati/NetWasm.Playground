"""Reads the names of the assemblies a .NET assembly references, from its ECMA-335 metadata."""
import struct

# Metadata table numbers (ECMA-335 II.22) whose row counts size the coded indexes below.
MODULE, TYPE_REF, TYPE_DEF, FIELD_PTR, FIELD, METHOD_PTR, METHOD_DEF, PARAM_PTR, PARAM = range(9)
INTERFACE_IMPL, MEMBER_REF, CONSTANT, CUSTOM_ATTRIBUTE, FIELD_MARSHAL, DECL_SECURITY = range(9, 15)
CLASS_LAYOUT, FIELD_LAYOUT, STAND_ALONE_SIG, EVENT_MAP, EVENT_PTR, EVENT = range(15, 21)
PROPERTY_MAP, PROPERTY_PTR, PROPERTY, METHOD_SEMANTICS, METHOD_IMPL, MODULE_REF = range(21, 27)
TYPE_SPEC, IMPL_MAP, FIELD_RVA, ENC_LOG, ENC_MAP, ASSEMBLY = range(27, 33)
ASSEMBLY_PROCESSOR, ASSEMBLY_OS, ASSEMBLY_REF, ASSEMBLY_REF_PROCESSOR, ASSEMBLY_REF_OS = 0x21, 0x22, 0x23, 0x24, 0x25
FILE, EXPORTED_TYPE, MANIFEST_RESOURCE, GENERIC_PARAM, METHOD_SPEC, GENERIC_PARAM_CONSTRAINT = (
    0x26, 0x27, 0x28, 0x2A, 0x2B, 0x2C)

# Coded indexes (ECMA-335 II.24.2.6): the tables each can name. None is an unused tag.
TYPE_DEF_OR_REF = (TYPE_DEF, TYPE_REF, TYPE_SPEC)
HAS_CONSTANT = (FIELD, PARAM, PROPERTY)
HAS_CUSTOM_ATTRIBUTE = (METHOD_DEF, FIELD, TYPE_REF, TYPE_DEF, PARAM, INTERFACE_IMPL, MEMBER_REF, MODULE,
                        DECL_SECURITY, PROPERTY, EVENT, STAND_ALONE_SIG, MODULE_REF, TYPE_SPEC, ASSEMBLY,
                        ASSEMBLY_REF, FILE, EXPORTED_TYPE, MANIFEST_RESOURCE, GENERIC_PARAM,
                        GENERIC_PARAM_CONSTRAINT, METHOD_SPEC)
HAS_FIELD_MARSHAL = (FIELD, PARAM)
HAS_DECL_SECURITY = (TYPE_DEF, METHOD_DEF, ASSEMBLY)
MEMBER_REF_PARENT = (TYPE_DEF, TYPE_REF, MODULE_REF, METHOD_DEF, TYPE_SPEC)
HAS_SEMANTICS = (EVENT, PROPERTY)
METHOD_DEF_OR_REF = (METHOD_DEF, MEMBER_REF)
MEMBER_FORWARDED = (FIELD, METHOD_DEF)
CUSTOM_ATTRIBUTE_TYPE = (None, None, METHOD_DEF, MEMBER_REF, None)
RESOLUTION_SCOPE = (MODULE, MODULE_REF, ASSEMBLY_REF, TYPE_REF)
IMPLEMENTATION = (FILE, ASSEMBLY_REF, EXPORTED_TYPE)

# The columns of every table up to ExportedType: a fixed width ('u2', 'u4'), a heap index ('string',
# 'guid', 'blob'), a table number (a simple index into that table) or a coded index's table tuple.
COLUMNS = {
    MODULE: ('u2', 'string', 'guid', 'guid', 'guid'),
    TYPE_REF: (RESOLUTION_SCOPE, 'string', 'string'),
    TYPE_DEF: ('u4', 'string', 'string', TYPE_DEF_OR_REF, FIELD, METHOD_DEF),
    FIELD_PTR: (FIELD,),
    FIELD: ('u2', 'string', 'blob'),
    METHOD_PTR: (METHOD_DEF,),
    METHOD_DEF: ('u4', 'u2', 'u2', 'string', 'blob', PARAM),
    PARAM_PTR: (PARAM,),
    PARAM: ('u2', 'u2', 'string'),
    INTERFACE_IMPL: (TYPE_DEF, TYPE_DEF_OR_REF),
    MEMBER_REF: (MEMBER_REF_PARENT, 'string', 'blob'),
    CONSTANT: ('u2', HAS_CONSTANT, 'blob'),
    CUSTOM_ATTRIBUTE: (HAS_CUSTOM_ATTRIBUTE, CUSTOM_ATTRIBUTE_TYPE, 'blob'),
    FIELD_MARSHAL: (HAS_FIELD_MARSHAL, 'blob'),
    DECL_SECURITY: ('u2', HAS_DECL_SECURITY, 'blob'),
    CLASS_LAYOUT: ('u2', 'u4', TYPE_DEF),
    FIELD_LAYOUT: ('u4', FIELD),
    STAND_ALONE_SIG: ('blob',),
    EVENT_MAP: (TYPE_DEF, EVENT),
    EVENT_PTR: (EVENT,),
    EVENT: ('u2', 'string', TYPE_DEF_OR_REF),
    PROPERTY_MAP: (TYPE_DEF, PROPERTY),
    PROPERTY_PTR: (PROPERTY,),
    PROPERTY: ('u2', 'string', 'blob'),
    METHOD_SEMANTICS: ('u2', METHOD_DEF, HAS_SEMANTICS),
    METHOD_IMPL: (TYPE_DEF, METHOD_DEF_OR_REF, METHOD_DEF_OR_REF),
    MODULE_REF: ('string',),
    TYPE_SPEC: ('blob',),
    IMPL_MAP: ('u2', MEMBER_FORWARDED, 'string', MODULE_REF),
    FIELD_RVA: ('u4', FIELD),
    ENC_LOG: ('u4', 'u4'),
    ENC_MAP: ('u4',),
    ASSEMBLY: ('u4', 'u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'string', 'string'),
    ASSEMBLY_PROCESSOR: ('u4',),
    ASSEMBLY_OS: ('u4', 'u4', 'u4'),
    ASSEMBLY_REF: ('u2', 'u2', 'u2', 'u2', 'u4', 'blob', 'string', 'string', 'blob'),
    ASSEMBLY_REF_PROCESSOR: ('u4', ASSEMBLY_REF),
    ASSEMBLY_REF_OS: ('u4', 'u4', 'u4', ASSEMBLY_REF),
    FILE: ('u4', 'string', 'blob'),
    EXPORTED_TYPE: ('u4', 'u4', 'string', 'string', IMPLEMENTATION),
}


def _metadata(image):
    """Returns the metadata root's bytes from a PE image."""
    if image[:2] != b'MZ':
        raise ValueError('Not a PE image')
    pe = struct.unpack_from('<I', image, 0x3C)[0]
    if image[pe:pe + 4] != b'PE\0\0':
        raise ValueError('Not a PE image')
    sections, optional_size = struct.unpack_from('<H', image, pe + 6)[0], struct.unpack_from('<H', image, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from('<H', image, optional)[0]
    directories = optional + {0x10B: 96, 0x20B: 112}[magic]
    cli_rva = struct.unpack_from('<I', image, directories + 14 * 8)[0]
    table = optional + optional_size

    def offset(rva):
        for index in range(sections):
            size, address, raw_size, raw = struct.unpack_from('<IIII', image, table + index * 40 + 8)
            if address <= rva < address + max(size, raw_size):
                return raw + rva - address
        raise ValueError('RVA outside every section')

    cli = offset(cli_rva)
    metadata_rva, metadata_size = struct.unpack_from('<II', image, cli + 8)
    start = offset(metadata_rva)
    return image[start:start + metadata_size]


class _Tables:
    """The rows of an image's metadata tables, up to ExportedType, read on demand."""

    def __init__(self, image):
        metadata = _metadata(image)
        if struct.unpack_from('<I', metadata, 0)[0] != 0x424A5342:
            raise ValueError('Not CLI metadata')
        version_length = struct.unpack_from('<I', metadata, 12)[0]
        count = struct.unpack_from('<H', metadata, 16 + version_length + 2)[0]
        header = 16 + version_length + 4
        streams = {}
        for _ in range(count):
            stream_offset, stream_size = struct.unpack_from('<II', metadata, header)
            end = metadata.index(b'\0', header + 8)
            streams[metadata[header + 8:end].decode('ascii')] = metadata[stream_offset:stream_offset + stream_size]
            # The name and its terminator are padded to a multiple of four bytes.
            header = header + 8 + ((end - header - 8) // 4 + 1) * 4
        self._tables = streams.get('#~', streams.get('#-'))
        self._strings = streams['#Strings']
        self._heap_sizes = self._tables[6]
        valid = struct.unpack_from('<Q', self._tables, 8)[0]
        self.rows = {}
        position = 24
        for number in range(64):
            if valid >> number & 1:
                self.rows[number] = struct.unpack_from('<I', self._tables, position)[0]
                position += 4
        if self._heap_sizes & 0x40:
            position += 4
        self._starts = {}
        for number in range(EXPORTED_TYPE + 1):
            self._starts[number] = position
            if number in self.rows:
                position += self.rows[number] * self._row_size(number)

    def _width(self, column):
        if column in ('u2', 'u4'):
            return int(column[1])
        if column == 'string':
            return 4 if self._heap_sizes & 1 else 2
        if column == 'guid':
            return 4 if self._heap_sizes & 2 else 2
        if column == 'blob':
            return 4 if self._heap_sizes & 4 else 2
        if isinstance(column, tuple):
            bits = (len(column) - 1).bit_length()
            largest = max(self.rows.get(item, 0) for item in column if item is not None)
            return 2 if largest < 1 << (16 - bits) else 4
        return 2 if self.rows.get(column, 0) < 1 << 16 else 4

    def _row_size(self, number):
        return sum(self._width(column) for column in COLUMNS[number])

    def table(self, number):
        """Each row as a list of its raw column values; strings are decoded and coded indexes split into
        (table, one-based row)."""
        position = self._starts[number]
        columns = COLUMNS[number]
        for _ in range(self.rows.get(number, 0)):
            values = []
            for column in columns:
                width = self._width(column)
                value = struct.unpack_from('<I' if width == 4 else '<H', self._tables, position)[0]
                position += width
                if column == 'string':
                    value = self._strings[value:self._strings.index(b'\0', value)].decode('utf-8')
                elif isinstance(column, tuple):
                    bits = (len(column) - 1).bit_length()
                    value = (column[value & ((1 << bits) - 1)], value >> bits)
                values.append(value)
            yield values


def assembly_references(image):
    """The names of the assemblies an assembly image references, in table order."""
    return [row[6] for row in _Tables(image).table(ASSEMBLY_REF)]


def referenced_types(image):
    """Each top-level type the image references from another assembly: (namespace, name, assembly)."""
    tables = _Tables(image)
    assemblies = [row[6] for row in tables.table(ASSEMBLY_REF)]
    return {(row[2], row[1], assemblies[row[0][1] - 1]) for row in tables.table(TYPE_REF)
            if row[0][0] == ASSEMBLY_REF and row[0][1] > 0}


def forwarded_types(image):
    """Each top-level type a facade forwards: (namespace, name) to the assembly that defines it."""
    tables = _Tables(image)
    assemblies = [row[6] for row in tables.table(ASSEMBLY_REF)]
    return {(row[3], row[2]): assemblies[row[4][1] - 1] for row in tables.table(EXPORTED_TYPE)
            if row[4][0] == ASSEMBLY_REF and row[4][1] > 0}
